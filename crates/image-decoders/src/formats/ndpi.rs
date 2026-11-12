//! Hamamatsu NDPI whole-slide images.
//!
//! An NDPI file looks like a classic TIFF and is not one. Three things set it
//! apart, and each is why a general TIFF reader cannot serve it:
//!
//! * **64-bit offsets in a 32-bit layout.** The header's first-IFD offset and
//!   every next-IFD offset are eight bytes, and each IFD is followed by a
//!   table holding the high 32 bits of every entry's value/offset. A reader
//!   that ignores the table sees a valid classic TIFF below 4 GiB and garbage
//!   above it.
//! * **One JPEG per image, however large.** A level is a single strip holding
//!   one JPEG stream. Its frame header cannot express more than 65535 pixels a
//!   side, so large levels record a size of zero there. Random access comes
//!   from restart markers: tag 65426 (McuStarts) lists where every restart
//!   interval begins, and an interval is a run of whole MCUs in one MCU row.
//! * **The pyramid is not marked.** Levels, focal planes, the macro photograph
//!   and the slide map are all plain top-level IFDs; tag 65421 (SourceLens)
//!   and tag 65424 (ZOffsetFromSlideCenter) say which is which.
//!
//! A region is decoded by assembling a small JPEG from the frame header (with
//! its size rewritten) and the restart intervals covering the region, then
//! handing that to the ordinary JPEG decoder. Everything reads through
//! [`NdpiFile`], which holds only the byte ranges supplied so far and answers
//! a missing one with `[need-range:OFFSET:LENGTH]`, so a multi-gigabyte slide
//! opens from a few kilobytes of directory and the intervals a view needs.
//! Offsets are `u64` throughout: `usize` is 32 bits in WebAssembly, and these
//! files routinely exceed it.

use super::json_value::{parse as parse_json, push_opt, to_json_string, JsonValue};
use super::scientific_common::{ScientificParsed, NEED_RANGE_MARKER};
use crate::DecodeError;
use std::io::Cursor;

const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_BITS_PER_SAMPLE: u16 = 258;
const TAG_COMPRESSION: u16 = 259;
const TAG_MAKE: u16 = 271;
const TAG_MODEL: u16 = 272;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_SAMPLES_PER_PIXEL: u16 = 277;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_X_RESOLUTION: u16 = 282;
const TAG_Y_RESOLUTION: u16 = 283;
const TAG_RESOLUTION_UNIT: u16 = 296;
const TAG_SOFTWARE: u16 = 305;
const TAG_DATE_TIME: u16 = 306;
/// Present on every IFD of an NDPI file; its absence means "not NDPI".
const TAG_NDPI_FORMAT: u16 = 65420;
/// Objective magnification of a slide level; -1 for the macro image and -2
/// for the slide map.
const TAG_SOURCE_LENS: u16 = 65421;
const TAG_X_OFFSET: u16 = 65422;
const TAG_Y_OFFSET: u16 = 65423;
/// Focal plane, in nanometres from the slide centre.
const TAG_Z_OFFSET: u16 = 65424;
const TAG_MCU_STARTS: u16 = 65426;
const TAG_REFERENCE: u16 = 65427;
const TAG_MCU_STARTS_HIGH: u16 = 65432;
const TAG_SCANNER_SERIAL: u16 = 65442;
const TAG_PROPERTIES: u16 = 65449;

const COMPRESSION_JPEG: u32 = 7;
const LENS_MACRO: f64 = -1.0;

/// First read of an IFD or a JPEG header whose size is not known yet.
const PROBE_BYTES: u64 = 4096;
/// Out-of-line tag values are fetched together with this much around them:
/// a writer stores an IFD's strings and rationals side by side.
const VALUE_PROBE_BYTES: u64 = 2048;
const MAX_PAGES: usize = 4096;
/// A decoded region is handed over as f32 samples; this bounds that buffer.
const MAX_OUTPUT_PIXELS: u64 = 80_000_000;
/// Pixels decoded per assembled JPEG; larger regions are decoded in bands.
const MAX_CHUNK_PIXELS: u64 = 32_000_000;
const JPEG_MAX_SIDE: u64 = 65_535;
/// The whole-file decode shows the finest level within this many pixels.
const DEFAULT_MAX_PIXELS: f64 = 40_000_000.0;
/// Planned reads closer together than this are fetched as one.
const COALESCE_GAP_BYTES: u64 = 64 * 1024;
const MAX_PLANNED_RANGES: usize = 96;

fn err(message: impl AsRef<str>) -> DecodeError {
    DecodeError::new(format!("NDPI: {}", message.as_ref()))
}

/// The bytes of a file of known size of which only some ranges are present,
/// addressed by absolute 64-bit file offset. The NDPI counterpart of
/// `scientific_common::SparseFile`, which addresses by `usize`.
pub(crate) struct NdpiFile<'a> {
    size: u64,
    /// `(file offset, bytes)`, sorted by offset.
    pieces: Vec<(u64, &'a [u8])>,
}

impl<'a> NdpiFile<'a> {
    /// A whole file in memory.
    pub(crate) fn whole(data: &'a [u8]) -> Self {
        Self {
            size: data.len() as u64,
            pieces: vec![(0, data)],
        }
    }

    /// `size` bytes of which `pieces` (file offset, bytes) are present.
    pub(crate) fn new(size: u64, mut pieces: Vec<(u64, &'a [u8])>) -> Self {
        pieces.sort_by_key(|(offset, _)| *offset);
        Self { size, pieces }
    }

    fn find(&self, offset: u64, len: u64) -> Option<&'a [u8]> {
        let end = offset.checked_add(len)?;
        let after = self.pieces.partition_point(|(start, _)| *start <= offset);
        for &(start, bytes) in self.pieces[..after].iter().rev() {
            if start + bytes.len() as u64 >= end {
                let at = usize::try_from(offset - start).ok()?;
                return bytes.get(at..at + usize::try_from(len).ok()?);
            }
        }
        None
    }

    /// `len` bytes at `offset`. When they are missing, ask for the range
    /// `[fetch_from, fetch_from + fetch_len)` instead (widened to cover the
    /// bytes wanted and clamped to the file), so one read can bring what a
    /// later call will want.
    fn slice_from(
        &self,
        offset: u64,
        len: u64,
        fetch_from: u64,
        fetch_len: u64,
        context: &str,
    ) -> Result<&'a [u8], DecodeError> {
        let end = offset
            .checked_add(len)
            .filter(|&end| end <= self.size)
            .ok_or_else(|| err(format!("{context} lies outside the file")))?;
        if let Some(bytes) = self.find(offset, len) {
            return Ok(bytes);
        }
        let from = fetch_from.min(offset);
        let to = fetch_from.saturating_add(fetch_len).max(end).min(self.size);
        Err(DecodeError::new(format!(
            "{NEED_RANGE_MARKER}{from}:{}] NDPI {context}: bytes not read yet",
            to - from
        )))
    }

    fn slice(&self, offset: u64, len: u64, context: &str) -> Result<&'a [u8], DecodeError> {
        self.slice_from(offset, len, offset, len, context)
    }
}

fn u16_le(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn u64_le(bytes: &[u8], at: usize) -> u64 {
    u64::from(u32_le(bytes, at)) | u64::from(u32_le(bytes, at + 4)) << 32
}

/// One IFD entry: the classic twelve bytes plus the entry's slot in the
/// high-bits table that follows an NDPI directory.
#[derive(Clone)]
struct Entry {
    tag: u16,
    kind: u16,
    count: u64,
    low: [u8; 4],
    high: u32,
}

impl Entry {
    fn unit(&self) -> u64 {
        match self.kind {
            3 | 8 => 2,
            4 | 9 | 11 | 13 => 4,
            5 | 10 | 12 | 16 | 17 | 18 => 8,
            _ => 1,
        }
    }

    fn byte_len(&self) -> u64 {
        self.unit().saturating_mul(self.count)
    }

    /// Whether the value sits in the entry itself. NDPI stores every string
    /// out of line, even one short enough to fit.
    fn is_inline(&self) -> bool {
        self.byte_len() <= 4 && self.kind != 2
    }

    /// The value field read as a 64-bit offset (or a single 64-bit LONG).
    fn wide(&self) -> u64 {
        u64::from(u32::from_le_bytes(self.low)) | u64::from(self.high) << 32
    }

    /// A single inline number. A lone LONG is 64 bits wide in NDPI: that is
    /// how StripOffsets and StripByteCounts exceed 4 GiB.
    fn scalar(&self) -> Option<f64> {
        if self.count != 1 {
            return None;
        }
        match self.kind {
            1 | 7 => Some(f64::from(self.low[0])),
            6 => Some(f64::from(self.low[0] as i8)),
            3 => Some(f64::from(u16_le(&self.low, 0))),
            8 => Some(f64::from(u16_le(&self.low, 0) as i16)),
            #[allow(clippy::cast_precision_loss)] // offsets stay far below 2^53
            4 | 13 => Some(self.wide() as f64),
            9 => Some(f64::from(i32::from_le_bytes(self.low))),
            11 => Some(f64::from(f32::from_le_bytes(self.low))),
            _ => None,
        }
    }

    fn scalar_u64(&self) -> Option<u64> {
        match self.kind {
            4 | 13 if self.count == 1 => Some(self.wide()),
            _ => self
                .scalar()
                .filter(|value| *value >= 0.0)
                // Checked non-negative; inline scalars other than LONG fit 32 bits.
                .map(|value| {
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let value = value as u64;
                    value
                }),
        }
    }

    /// The value bytes, wherever they are stored.
    fn bytes(&self, file: &NdpiFile<'_>, context: &str) -> Result<Vec<u8>, DecodeError> {
        let len = self.byte_len();
        if self.is_inline() {
            // `len` is at most 4 here.
            #[allow(clippy::cast_possible_truncation)]
            return Ok(self.low[..len as usize].to_vec());
        }
        let offset = self.wide();
        let around = offset.saturating_sub(VALUE_PROBE_BYTES / 2);
        Ok(file
            .slice_from(offset, len, around, VALUE_PROBE_BYTES, context)?
            .to_vec())
    }

    fn text(&self, file: &NdpiFile<'_>, context: &str) -> Result<String, DecodeError> {
        let bytes = self.bytes(file, context)?;
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        Ok(bytes[..end]
            .iter()
            .map(|&b| b as char)
            .collect::<String>()
            .trim()
            .to_string())
    }

    fn first_number(&self, file: &NdpiFile<'_>, context: &str) -> Result<Option<f64>, DecodeError> {
        if let Some(value) = self.scalar() {
            return Ok(Some(value));
        }
        let bytes = self.bytes(file, context)?;
        Ok(match self.kind {
            5 if bytes.len() >= 8 => {
                let denominator = u32_le(&bytes, 4);
                (denominator != 0).then(|| f64::from(u32_le(&bytes, 0)) / f64::from(denominator))
            }
            12 if bytes.len() >= 8 => Some(f64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ])),
            3 if bytes.len() >= 2 => Some(f64::from(u16_le(&bytes, 0))),
            4 if bytes.len() >= 4 => Some(f64::from(u32_le(&bytes, 0))),
            _ => None,
        })
    }
}

/// One IFD: an image of the slide, with only the facts read from inline
/// values. Strings and rationals are read on demand from `entries`.
struct Page {
    width: u64,
    height: u64,
    compression: u32,
    samples: u32,
    bits: u32,
    strip_offset: u64,
    strip_len: u64,
    lens: f64,
    z_nm: f64,
    /// `(file offset, entry count)` of the McuStarts array, and of the array
    /// holding the high halves of its values.
    mcu_starts: Option<(u64, u64)>,
    mcu_starts_high: Option<(u64, u64)>,
    entries: Vec<Entry>,
}

impl Page {
    fn entry(&self, tag: u16) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.tag == tag)
    }

    fn text(&self, file: &NdpiFile<'_>, tag: u16) -> Result<Option<String>, DecodeError> {
        match self.entry(tag) {
            Some(entry) if entry.kind == 2 => {
                Ok(Some(entry.text(file, "tag value")?).filter(|text| !text.is_empty()))
            }
            _ => Ok(None),
        }
    }

    fn number(&self, file: &NdpiFile<'_>, tag: u16) -> Result<Option<f64>, DecodeError> {
        match self.entry(tag) {
            Some(entry) => entry.first_number(file, "tag value"),
            None => Ok(None),
        }
    }

    fn pixels(&self) -> u64 {
        self.width.saturating_mul(self.height)
    }
}

fn read_page(file: &NdpiFile<'_>, offset: u64) -> Result<(Page, u64), DecodeError> {
    let count = u64::from(u16_le(
        file.slice_from(offset, 2, offset, PROBE_BYTES, "directory")?,
        0,
    ));
    // Entries, the 8-byte next-IFD offset, then one high-bits word per entry.
    let body = file.slice_from(offset + 2, count * 16 + 8, offset, PROBE_BYTES, "directory")?;
    // `count` came from a u16.
    #[allow(clippy::cast_possible_truncation)]
    let count = count as usize;
    let next = u64_le(body, count * 12);
    let entries: Vec<Entry> = (0..count)
        .map(|index| {
            let at = index * 12;
            Entry {
                tag: u16_le(body, at),
                kind: u16_le(body, at + 2),
                count: u64::from(u32_le(body, at + 4)),
                low: [body[at + 8], body[at + 9], body[at + 10], body[at + 11]],
                high: u32_le(body, count * 12 + 8 + index * 4),
            }
        })
        .collect();
    let find = |tag: u16| entries.iter().find(|entry| entry.tag == tag);
    let unsigned = |tag: u16| find(tag).and_then(Entry::scalar_u64);
    let number = |tag: u16| find(tag).and_then(Entry::scalar);
    let array = |tag: u16| {
        find(tag)
            .filter(|entry| entry.kind == 4 && !entry.is_inline())
            .map(|entry| (entry.wide(), entry.count))
    };
    // u32 is ample for these three tags; a larger value is not an image.
    let small = |tag: u16, fallback: u32| {
        unsigned(tag)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(fallback)
    };
    let page = Page {
        width: unsigned(TAG_IMAGE_WIDTH).unwrap_or(0),
        height: unsigned(TAG_IMAGE_LENGTH).unwrap_or(0),
        compression: small(TAG_COMPRESSION, 1),
        samples: small(TAG_SAMPLES_PER_PIXEL, 1),
        // Three samples store BitsPerSample out of line; NDPI is 8-bit there.
        bits: small(TAG_BITS_PER_SAMPLE, 8),
        strip_offset: unsigned(TAG_STRIP_OFFSETS).unwrap_or(0),
        strip_len: unsigned(TAG_STRIP_BYTE_COUNTS).unwrap_or(0),
        lens: number(TAG_SOURCE_LENS).unwrap_or(f64::NAN),
        z_nm: number(TAG_Z_OFFSET).unwrap_or(0.0),
        mcu_starts: array(TAG_MCU_STARTS),
        mcu_starts_high: array(TAG_MCU_STARTS_HIGH),
        entries,
    };
    Ok((page, next))
}

fn read_pages(file: &NdpiFile<'_>) -> Result<Vec<Page>, DecodeError> {
    if file.size < 12 {
        return Err(err("file is too short"));
    }
    let head = file.slice_from(0, 12, 0, PROBE_BYTES, "header")?;
    if &head[..4] != b"II*\0" {
        return Err(err("not a little-endian TIFF-structured file"));
    }
    let mut offset = u64_le(head, 4);
    let mut pages = Vec::new();
    let mut visited = Vec::new();
    while offset != 0 {
        if offset >= file.size || pages.len() >= MAX_PAGES {
            return Err(err("directory chain is corrupt"));
        }
        let (page, next) = read_page(file, offset)?;
        if pages.is_empty() && page.entry(TAG_NDPI_FORMAT).is_none() {
            return Err(err(
                "the Hamamatsu format tag (65420) is missing; this is not an NDPI file",
            ));
        }
        pages.push(page);
        visited.push(offset);
        if visited.contains(&next) {
            return Err(err("directory chain loops"));
        }
        offset = next;
    }
    Ok(pages)
}

/// One image the file offers: the slide at a focal plane, or the macro
/// photograph. `levels` index into the page list, finest first.
struct Plane {
    z_nm: f64,
    levels: Vec<usize>,
}

struct Slide {
    pages: Vec<Page>,
    /// Focal planes of the slide, ordered by Z.
    planes: Vec<Plane>,
    macro_page: Option<usize>,
}

fn read_slide(file: &NdpiFile<'_>) -> Result<Slide, DecodeError> {
    let pages = read_pages(file)?;
    let usable = |page: &Page| page.width > 0 && page.height > 0 && page.strip_len > 0;
    let mut scanned: Vec<usize> = (0..pages.len())
        .filter(|&index| usable(&pages[index]) && pages[index].lens > 0.0)
        .collect();
    if scanned.is_empty() {
        // No SourceLens anywhere: treat every JPEG image as a level of one plane.
        scanned = (0..pages.len())
            .filter(|&index| {
                usable(&pages[index])
                    && pages[index].lens.is_nan()
                    && pages[index].compression == COMPRESSION_JPEG
            })
            .collect();
    }
    if scanned.is_empty() {
        return Err(err("no slide image found"));
    }
    let mut depths: Vec<f64> = scanned.iter().map(|&index| pages[index].z_nm).collect();
    depths.sort_by(f64::total_cmp);
    depths.dedup();
    let planes = depths
        .into_iter()
        .map(|z_nm| {
            let mut levels: Vec<usize> = scanned
                .iter()
                .copied()
                .filter(|&index| pages[index].z_nm == z_nm)
                .collect();
            levels.sort_by(|a, b| pages[*b].width.cmp(&pages[*a].width));
            levels.dedup_by_key(|index| pages[*index].width);
            Plane { z_nm, levels }
        })
        .collect();
    let macro_page =
        (0..pages.len()).find(|&index| usable(&pages[index]) && pages[index].lens == LENS_MACRO);
    Ok(Slide {
        pages,
        planes,
        macro_page,
    })
}

/// What the frame and scan headers of a level's JPEG stream say.
struct JpegHeader {
    /// Where the entropy-coded data begins, from the start of the stream.
    scan_start: usize,
    /// Position of the frame header's height field.
    size_at: usize,
    width: u64,
    height: u64,
    components: u32,
    mcu_width: u64,
    mcu_height: u64,
    /// MCUs per restart interval; 0 when the stream has no restart markers.
    restart_interval: u64,
    /// Baseline or extended sequential with one interleaved scan: the only
    /// shape whose restart intervals can be decoded on their own.
    sequential: bool,
}

/// Parse up to the end of the first scan header, or `None` when `prefix`
/// stops short of it.
fn parse_jpeg_header(prefix: &[u8]) -> Result<Option<JpegHeader>, DecodeError> {
    if prefix.len() < 4 {
        return Ok(None);
    }
    if prefix[0] != 0xFF || prefix[1] != 0xD8 {
        return Err(err("image data is not a JPEG stream"));
    }
    let mut at = 2usize;
    let mut frame: Option<(usize, u64, u64, u32, u64, u64, bool)> = None;
    let mut restart_interval = 0u64;
    loop {
        if at + 4 > prefix.len() {
            return Ok(None);
        }
        if prefix[at] != 0xFF {
            return Err(err("JPEG header is corrupt"));
        }
        let marker = prefix[at + 1];
        if marker == 0xFF {
            at += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            at += 2;
            continue;
        }
        let length = usize::from(u16::from_be_bytes([prefix[at + 2], prefix[at + 3]]));
        let end = at + 2 + length;
        if length < 2 {
            return Err(err("JPEG header is corrupt"));
        }
        if end > prefix.len() {
            return Ok(None);
        }
        let body = &prefix[at + 4..end];
        match marker {
            0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                if body.len() < 6 || body.len() < 6 + usize::from(body[5]) * 3 {
                    return Err(err("JPEG frame header is corrupt"));
                }
                let components = u32::from(body[5]);
                let (mut h_max, mut v_max) = (1u64, 1u64);
                for index in 0..usize::from(body[5]) {
                    let sampling = body[6 + index * 3 + 1];
                    h_max = h_max.max(u64::from(sampling >> 4));
                    v_max = v_max.max(u64::from(sampling & 0x0F));
                }
                // A single-component scan is not interleaved: its MCU is one block.
                let (mcu_width, mcu_height) = if components == 1 {
                    (8, 8)
                } else {
                    (8 * h_max, 8 * v_max)
                };
                frame = Some((
                    at + 5,
                    u64::from(u16::from_be_bytes([body[3], body[4]])),
                    u64::from(u16::from_be_bytes([body[1], body[2]])),
                    components,
                    mcu_width,
                    mcu_height,
                    (marker == 0xC0 || marker == 0xC1) && body[0] == 8,
                ));
            }
            0xDD if body.len() >= 2 => {
                restart_interval = u64::from(u16::from_be_bytes([body[0], body[1]]));
            }
            0xDA => {
                let (size_at, width, height, components, mcu_width, mcu_height, sequential) =
                    frame.ok_or_else(|| err("JPEG scan precedes its frame header"))?;
                let scan_components = body.first().map_or(0, |&count| u32::from(count));
                return Ok(Some(JpegHeader {
                    scan_start: end,
                    size_at,
                    width,
                    height,
                    components,
                    mcu_width,
                    mcu_height,
                    restart_interval,
                    sequential: sequential && scan_components == components,
                }));
            }
            _ => {}
        }
        at = end;
    }
}

fn jpeg_header(file: &NdpiFile<'_>, page: &Page) -> Result<JpegHeader, DecodeError> {
    if page.compression != COMPRESSION_JPEG {
        return Err(err(format!(
            "compression {} is not supported (only JPEG slides are)",
            page.compression
        )));
    }
    let mut probe = PROBE_BYTES;
    loop {
        let len = probe.min(page.strip_len);
        let prefix = file.slice(page.strip_offset, len, "JPEG header")?;
        if let Some(header) = parse_jpeg_header(prefix)? {
            return Ok(header);
        }
        if len == page.strip_len || probe > 16 * 1024 * 1024 {
            return Err(err("JPEG header is incomplete"));
        }
        probe *= 16;
    }
}

/// How a level's restart intervals tile it: `columns` intervals of
/// `interval_width` pixels across, `rows` MCU rows of `mcu_height` down.
#[derive(Clone, Copy)]
struct Grid {
    columns: u64,
    rows: u64,
    interval_width: u64,
    mcu_height: u64,
}

fn restart_grid(page: &Page, header: &JpegHeader) -> Option<Grid> {
    let (_, count) = page.mcu_starts?;
    if !header.sequential || header.restart_interval == 0 {
        return None;
    }
    let mcus_per_row = page.width.div_ceil(header.mcu_width);
    let rows = page.height.div_ceil(header.mcu_height);
    if !mcus_per_row.is_multiple_of(header.restart_interval) {
        return None;
    }
    let columns = mcus_per_row / header.restart_interval;
    let interval_width = header.restart_interval * header.mcu_width;
    if columns.checked_mul(rows) != Some(count) || interval_width > JPEG_MAX_SIDE {
        return None;
    }
    if page
        .mcu_starts_high
        .is_some_and(|(_, high_count)| high_count != count)
    {
        return None;
    }
    Some(Grid {
        columns,
        rows,
        interval_width,
        mcu_height: header.mcu_height,
    })
}

/// Reads McuStarts. The values are offsets from the start of the strip in
/// the files Hamamatsu scanners write; `absolute` covers a writer that stored
/// file offsets instead, told apart by where interval 0 has to begin.
struct McuStarts<'a, 'f> {
    file: &'f NdpiFile<'a>,
    page: &'f Page,
    low: (u64, u64),
    absolute: bool,
}

impl<'a, 'f> McuStarts<'a, 'f> {
    fn open(
        file: &'f NdpiFile<'a>,
        page: &'f Page,
        header: &JpegHeader,
    ) -> Result<Self, DecodeError> {
        let low = page
            .mcu_starts
            .ok_or_else(|| err("level has no restart-interval index"))?;
        let mut starts = Self {
            file,
            page,
            low,
            absolute: false,
        };
        let first = starts.raw(0)?;
        let scan_start = header.scan_start as u64;
        if first == page.strip_offset + scan_start && page.strip_offset != 0 {
            starts.absolute = true;
        } else if first != scan_start {
            return Err(err("restart-interval index does not match the JPEG stream"));
        }
        Ok(starts)
    }

    fn word(&self, array: (u64, u64), index: u64) -> Result<u64, DecodeError> {
        let (offset, count) = array;
        // A miss fetches the whole array: every later region needs more of it.
        let bytes = self.file.slice_from(
            offset + index * 4,
            4,
            offset,
            count * 4,
            "restart-interval index",
        )?;
        Ok(u64::from(u32_le(bytes, 0)))
    }

    fn raw(&self, index: u64) -> Result<u64, DecodeError> {
        let low = self.word(self.low, index)?;
        let high = match self.page.mcu_starts_high {
            Some(array) => self.word(array, index)?,
            None => 0,
        };
        Ok(low | high << 32)
    }

    /// File offset at which interval `index` begins; the end of the strip for
    /// one past the last.
    fn at(&self, index: u64) -> Result<u64, DecodeError> {
        let strip_end = self.page.strip_offset + self.page.strip_len;
        if index >= self.low.1 {
            return Ok(strip_end);
        }
        let raw = self.raw(index)?;
        let offset = if self.absolute {
            raw
        } else {
            self.page.strip_offset + raw
        };
        if offset > strip_end {
            return Err(err("restart interval lies outside the image data"));
        }
        Ok(offset)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: u64,
    y: u64,
    width: u64,
    height: u64,
}

/// The intervals to decode for `rect`: one interval/MCU row more on every
/// side than the rectangle touches. Subsampled chroma is interpolated across
/// MCU borders, so a tile decoded without its neighbours would differ along
/// its edges from the same pixels decoded as part of the whole image.
#[derive(Clone, Copy)]
struct Blocks {
    column0: u64,
    column1: u64,
    row0: u64,
    row1: u64,
}

fn blocks_for(rect: Rect, grid: Grid) -> Blocks {
    let last_column = (rect.x + rect.width - 1) / grid.interval_width;
    let last_row = (rect.y + rect.height - 1) / grid.mcu_height;
    Blocks {
        column0: (rect.x / grid.interval_width).saturating_sub(1),
        column1: (last_column + 1).min(grid.columns - 1),
        row0: (rect.y / grid.mcu_height).saturating_sub(1),
        row1: (last_row + 1).min(grid.rows - 1),
    }
}

/// Decoding options, as sent by the viewer.
struct Options {
    series: usize,
    plane: Option<usize>,
    level: Option<usize>,
    rect: Option<(f64, f64, f64, f64)>,
    max_pixels: f64,
}

fn parse_options(options_json: &str) -> Options {
    let mut options = Options {
        series: 0,
        plane: None,
        level: None,
        rect: None,
        max_pixels: DEFAULT_MAX_PIXELS,
    };
    let Ok(root) = parse_json(options_json) else {
        return options;
    };
    let index = |value: Option<&JsonValue>| {
        value
            .and_then(JsonValue::as_num)
            .filter(|number| number.is_finite() && *number >= 0.0)
            // Checked finite and non-negative; a huge index simply selects nothing.
            .map(|number| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let number = number as usize;
                number
            })
    };
    if let Some(indices) = root.get("indices") {
        options.series = index(indices.get("S")).unwrap_or(0);
        options.plane = index(indices.get("Z"));
    }
    options.level = index(root.get("level"));
    if let Some(rect) = root.get("rect") {
        let field = |name: &str| rect.get(name).and_then(JsonValue::as_num);
        if let (Some(x), Some(y), Some(width), Some(height)) =
            (field("x"), field("y"), field("width"), field("height"))
        {
            options.rect = Some((x, y, width, height));
        }
    }
    if let Some(max) = root
        .get("maxPixels")
        .and_then(JsonValue::as_num)
        .filter(|max| *max >= 1.0)
    {
        options.max_pixels = max;
    }
    options
}

/// The image `options` select, resolved against the file.
struct Selection<'s> {
    slide: &'s Slide,
    is_macro: bool,
    plane_index: usize,
    /// Page indices of the selected image's levels, finest first.
    levels: &'s [usize],
}

impl<'s> Selection<'s> {
    fn new(slide: &'s Slide, options: &Options) -> Result<Self, DecodeError> {
        if options.series == 1 {
            let page = slide
                .macro_page
                .as_ref()
                .ok_or_else(|| err("this slide has no macro image"))?;
            return Ok(Self {
                slide,
                is_macro: true,
                plane_index: 0,
                levels: std::slice::from_ref(page),
            });
        }
        if options.series > 1 {
            return Err(err("image index out of range"));
        }
        // Without a request, the plane nearest the slide's nominal focus.
        let plane_index = match options.plane {
            Some(index) => index,
            None => (0..slide.planes.len())
                .min_by(|a, b| {
                    slide.planes[*a]
                        .z_nm
                        .abs()
                        .total_cmp(&slide.planes[*b].z_nm.abs())
                })
                .unwrap_or(0),
        };
        let plane = slide
            .planes
            .get(plane_index)
            .ok_or_else(|| err("focal plane index out of range"))?;
        Ok(Self {
            slide,
            is_macro: false,
            plane_index,
            levels: &plane.levels,
        })
    }

    fn page(&self, level: usize) -> Result<&'s Page, DecodeError> {
        self.levels
            .get(level)
            .map(|&index| &self.slide.pages[index])
            .ok_or_else(|| err("pyramid level out of range"))
    }

    fn full(&self) -> &'s Page {
        &self.slide.pages[self.levels[0]]
    }

    /// Linear reduction of `level` against the full-resolution image.
    fn factor(&self, level: usize) -> u64 {
        let page = &self.slide.pages[self.levels[level]];
        // Widths are image dimensions, far below 2^53.
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss
        )]
        let factor = (self.full().width as f64 / page.width.max(1) as f64).round() as u64;
        factor.max(1)
    }

    /// The level a request without one gets: the finest within `max_pixels`.
    fn default_level(&self, max_pixels: f64) -> usize {
        #[allow(clippy::cast_precision_loss)]
        let fits =
            |level: &usize| self.slide.pages[self.levels[*level]].pixels() as f64 <= max_pixels;
        (0..self.levels.len())
            .find(fits)
            .unwrap_or(self.levels.len() - 1)
    }

    fn rect(&self, level: usize, options: &Options) -> Result<Rect, DecodeError> {
        let page = self.page(level)?;
        let Some((x, y, width, height)) = options.rect else {
            return Ok(Rect {
                x: 0,
                y: 0,
                width: page.width,
                height: page.height,
            });
        };
        let clamp = |value: f64, max: u64| {
            // Clamped into [0, max] before the cast.
            #[allow(
                clippy::cast_precision_loss,
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss
            )]
            let value = value.floor().clamp(0.0, max as f64) as u64;
            value
        };
        let left = clamp(x, page.width);
        let top = clamp(y, page.height);
        let right = clamp(x + width, page.width);
        let bottom = clamp(y + height, page.height);
        if right <= left || bottom <= top {
            return Err(err("requested region lies outside the image"));
        }
        Ok(Rect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

/// Byte ranges of the restart intervals `blocks` covers, one per MCU row.
fn interval_ranges(
    starts: &McuStarts<'_, '_>,
    grid: Grid,
    blocks: Blocks,
) -> Result<Vec<(u64, u64)>, DecodeError> {
    (blocks.row0..=blocks.row1)
        .map(|row| {
            let from = starts.at(row * grid.columns + blocks.column0)?;
            let to = starts.at(row * grid.columns + blocks.column1 + 1)?;
            if to < from {
                return Err(err("restart-interval index is not ascending"));
            }
            Ok((from, to - from))
        })
        .collect()
}

/// Merge ranges that are close enough to be cheaper as one read.
fn coalesce(mut ranges: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    ranges.sort_unstable();
    let mut gap = COALESCE_GAP_BYTES;
    loop {
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for &(offset, length) in &ranges {
            match merged.last_mut() {
                Some((start, span)) if offset <= *start + *span + gap => {
                    *span = (*span).max(offset + length - *start);
                }
                _ => merged.push((offset, length)),
            }
        }
        if merged.len() <= MAX_PLANNED_RANGES {
            return merged;
        }
        gap *= 4;
    }
}

fn check_output(rect: Rect) -> Result<(), DecodeError> {
    if rect.width.saturating_mul(rect.height) > MAX_OUTPUT_PIXELS {
        return Err(err(format!(
            "a {}x{} region is too large to decode at once",
            rect.width, rect.height
        )));
    }
    Ok(())
}

fn decode_jpeg(stream: &[u8], components: u32) -> Result<(Vec<u8>, usize, usize), DecodeError> {
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let options = DecoderOptions::default()
        .set_max_width(JPEG_MAX_SIDE as usize)
        .set_max_height(JPEG_MAX_SIDE as usize)
        .jpeg_set_out_colorspace(if components == 1 {
            ColorSpace::Luma
        } else {
            ColorSpace::RGB
        });
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(Cursor::new(stream), options);
    let pixels = decoder
        .decode()
        .map_err(|error| err(format!("JPEG decode failed: {error:?}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| err("JPEG decoder reported no image size"))?;
    Ok((pixels, usize::from(info.width), usize::from(info.height)))
}

/// A JPEG stream holding exactly the intervals of `blocks`: the level's own
/// headers with the frame size rewritten, then each interval with its
/// trailing restart marker renumbered to count from zero.
fn assemble_jpeg(
    file: &NdpiFile<'_>,
    page: &Page,
    header: &JpegHeader,
    starts: &McuStarts<'_, '_>,
    grid: Grid,
    blocks: Blocks,
) -> Result<Vec<u8>, DecodeError> {
    let columns = blocks.column1 - blocks.column0 + 1;
    let rows = blocks.row1 - blocks.row0 + 1;
    let width = u16::try_from(columns * grid.interval_width)
        .map_err(|_| err("region is too wide for one JPEG"))?;
    let height = u16::try_from(rows * grid.mcu_height)
        .map_err(|_| err("region is too tall for one JPEG"))?;
    let mut jpeg = file
        .slice(page.strip_offset, header.scan_start as u64, "JPEG header")?
        .to_vec();
    jpeg[header.size_at..header.size_at + 2].copy_from_slice(&height.to_be_bytes());
    jpeg[header.size_at + 2..header.size_at + 4].copy_from_slice(&width.to_be_bytes());
    let total = columns * rows;
    let mut written = 0u64;
    for row in blocks.row0..=blocks.row1 {
        let first = row * grid.columns + blocks.column0;
        let row_start = starts.at(first)?;
        let row_end = starts.at(first + columns)?;
        let bytes = file.slice(row_start, row_end.saturating_sub(row_start), "image data")?;
        for column in 0..columns {
            let from = usize::try_from(starts.at(first + column)? - row_start)
                .map_err(|_| err("restart interval is too long"))?;
            let to = usize::try_from(starts.at(first + column + 1)? - row_start)
                .map_err(|_| err("restart interval is too long"))?;
            let mut interval = bytes
                .get(from..to)
                .ok_or_else(|| err("restart-interval index is not ascending"))?;
            let is_last_of_image = first + column + 1 >= starts.low.1;
            match interval {
                [body @ .., 0xFF, 0xD0..=0xD7] => interval = body,
                [body @ .., 0xFF, 0xD9] if is_last_of_image => interval = body,
                // The stream's last interval may end without a marker at all.
                _ if is_last_of_image => {}
                _ => {
                    return Err(err(
                        "restart-interval index does not point at restart markers",
                    ))
                }
            }
            jpeg.extend_from_slice(interval);
            written += 1;
            if written < total {
                // `% 8` keeps this in 0..8.
                #[allow(clippy::cast_possible_truncation)]
                let marker = 0xD0 + ((written - 1) % 8) as u8;
                jpeg.extend_from_slice(&[0xFF, marker]);
            }
        }
    }
    jpeg.extend_from_slice(&[0xFF, 0xD9]);
    Ok(jpeg)
}

/// Copy the part of a decoded `source` image (whose top-left sits at
/// `source_x`, `source_y` in level coordinates) that falls inside `rect`.
#[allow(clippy::too_many_arguments)]
fn blit(
    out: &mut [f32],
    rect: Rect,
    channels: usize,
    source: &[u8],
    source_width: usize,
    source_height: usize,
    source_x: u64,
    source_y: u64,
) {
    let left = rect.x.max(source_x);
    let top = rect.y.max(source_y);
    let right = (rect.x + rect.width).min(source_x + source_width as u64);
    let bottom = (rect.y + rect.height).min(source_y + source_height as u64);
    if right <= left || bottom <= top {
        return;
    }
    // All four differences are bounded by an in-memory image's dimensions.
    #[allow(clippy::cast_possible_truncation)]
    let (run, out_x, in_x, out_width) = (
        (right - left) as usize * channels,
        (left - rect.x) as usize,
        (left - source_x) as usize,
        rect.width as usize,
    );
    for y in top..bottom {
        #[allow(clippy::cast_possible_truncation)]
        let (out_row, in_row) = ((y - rect.y) as usize, (y - source_y) as usize);
        let from = (in_row * source_width + in_x) * channels;
        let to = (out_row * out_width + out_x) * channels;
        let Some(samples) = source.get(from..from + run) else {
            return;
        };
        for (target, &sample) in out[to..to + run].iter_mut().zip(samples) {
            *target = f32::from(sample);
        }
    }
}

struct Decoded {
    rect: Rect,
    channels: u32,
    data: Vec<f32>,
}

fn decode_rect(file: &NdpiFile<'_>, page: &Page, rect: Rect) -> Result<Decoded, DecodeError> {
    check_output(rect)?;
    let header = jpeg_header(file, page)?;
    let channels: usize = if header.components == 1 { 1 } else { 3 };
    // Bounded by MAX_OUTPUT_PIXELS above.
    #[allow(clippy::cast_possible_truncation)]
    let mut data = vec![0f32; (rect.width * rect.height) as usize * channels];

    let Some(grid) = restart_grid(page, &header) else {
        // No usable restart intervals: the level decodes only as a whole.
        if page.width > JPEG_MAX_SIDE
            || page.height > JPEG_MAX_SIDE
            || page.pixels() > MAX_OUTPUT_PIXELS
        {
            return Err(err(format!(
                "a {}x{} level without a restart-interval index cannot be decoded in parts",
                page.width, page.height
            )));
        }
        let mut stream = file
            .slice(page.strip_offset, page.strip_len, "image data")?
            .to_vec();
        if header.width == 0 || header.height == 0 {
            // Both checked against JPEG_MAX_SIDE above.
            #[allow(clippy::cast_possible_truncation)]
            let (width, height) = (page.width as u16, page.height as u16);
            stream[header.size_at..header.size_at + 2].copy_from_slice(&height.to_be_bytes());
            stream[header.size_at + 2..header.size_at + 4].copy_from_slice(&width.to_be_bytes());
        }
        let (pixels, width, height) = decode_jpeg(&stream, header.components)?;
        blit(&mut data, rect, channels, &pixels, width, height, 0, 0);
        return Ok(Decoded {
            rect,
            channels: channels as u32,
            data,
        });
    };

    let starts = McuStarts::open(file, page, &header)?;
    let blocks = blocks_for(rect, grid);
    // Ask for every missing interval before decoding any, so that a caller
    // reading on demand is told about all of a region in as few answers as
    // the layout allows.
    for (offset, length) in interval_ranges(&starts, grid, blocks)? {
        file.slice(offset, length, "image data")?;
    }
    let columns_per_chunk = (JPEG_MAX_SIDE / grid.interval_width).max(1);
    let mut column = blocks.column0;
    while column <= blocks.column1 {
        let last_column = (column + columns_per_chunk - 1).min(blocks.column1);
        let chunk_width = (last_column - column + 1) * grid.interval_width;
        let rows_per_chunk = (MAX_CHUNK_PIXELS / (chunk_width * grid.mcu_height))
            .clamp(1, JPEG_MAX_SIDE / grid.mcu_height);
        let mut row = blocks.row0;
        while row <= blocks.row1 {
            let last_row = (row + rows_per_chunk - 1).min(blocks.row1);
            let chunk = Blocks {
                column0: column,
                column1: last_column,
                row0: row,
                row1: last_row,
            };
            let jpeg = assemble_jpeg(file, page, &header, &starts, grid, chunk)?;
            let (pixels, width, height) = decode_jpeg(&jpeg, header.components)?;
            blit(
                &mut data,
                rect,
                channels,
                &pixels,
                width,
                height,
                column * grid.interval_width,
                row * grid.mcu_height,
            );
            row = last_row + 1;
        }
        column = last_column + 1;
    }
    Ok(Decoded {
        rect,
        channels: channels as u32,
        data,
    })
}

fn num(value: u64) -> JsonValue {
    // Sizes and offsets here stay far below 2^53.
    #[allow(clippy::cast_precision_loss)]
    JsonValue::Num(value as f64)
}

/// Micrometres per pixel along one axis of `page`, from its resolution tags.
fn microns_per_pixel(
    file: &NdpiFile<'_>,
    page: &Page,
    tag: u16,
) -> Result<Option<f64>, DecodeError> {
    let Some(resolution) = page.number(file, tag)?.filter(|value| *value > 0.0) else {
        return Ok(None);
    };
    Ok(match page.number(file, TAG_RESOLUTION_UNIT)? {
        Some(3.0) => Some(10_000.0 / resolution),
        Some(2.0) => Some(25_400.0 / resolution),
        _ => None,
    })
}

/// The `Key=Value` lines of the scanner's property map (tag 65449).
fn properties(text: &str) -> Vec<(String, JsonValue)> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .filter(|(key, _)| !key.is_empty())
        .take(256)
        .map(|(key, value)| (key, JsonValue::Str(value)))
        .collect()
}

/// Metadata of the selected image. `level` is the level being shown, whose
/// reduction scales the physical pixel size the measurement tools read.
fn metadata(
    file: &NdpiFile<'_>,
    selection: &Selection<'_>,
    level: usize,
) -> Result<Vec<(String, JsonValue)>, DecodeError> {
    let slide = selection.slide;
    let full = selection.full();
    #[allow(clippy::cast_precision_loss)]
    let factor = selection.factor(level) as f64;
    let mut fields = JsonValue::obj();
    fields.push(("format".to_string(), JsonValue::Str("NDPI".to_string())));
    for (key, tag) in [
        ("make", TAG_MAKE),
        ("model", TAG_MODEL),
        ("software", TAG_SOFTWARE),
        ("dateTime", TAG_DATE_TIME),
        ("slideReference", TAG_REFERENCE),
        ("scannerSerialNumber", TAG_SCANNER_SERIAL),
    ] {
        push_opt(&mut fields, key, full.text(file, tag)?.map(JsonValue::Str));
    }
    if full.lens > 0.0 {
        fields.push(("magnification".to_string(), JsonValue::Num(full.lens)));
    }
    for (key, tag) in [
        ("scalingXUm", TAG_X_RESOLUTION),
        ("scalingYUm", TAG_Y_RESOLUTION),
    ] {
        push_opt(
            &mut fields,
            key,
            microns_per_pixel(file, full, tag)?.map(|size| JsonValue::Num(size * factor)),
        );
    }
    for (key, tag) in [("xOffsetNm", TAG_X_OFFSET), ("yOffsetNm", TAG_Y_OFFSET)] {
        push_opt(
            &mut fields,
            key,
            full.number(file, tag)?.map(JsonValue::Num),
        );
    }
    if !selection.is_macro {
        fields.push(("zOffsetNm".to_string(), JsonValue::Num(full.z_nm)));
        fields.push((
            "focalPlaneOffsetsNm".to_string(),
            JsonValue::Arr(
                slide
                    .planes
                    .iter()
                    .map(|plane| JsonValue::Num(plane.z_nm))
                    .collect(),
            ),
        ));
    }
    fields.push((
        "pyramidLevels".to_string(),
        num(selection.levels.len() as u64),
    ));
    fields.push((
        "levelReductions".to_string(),
        JsonValue::Arr(
            (0..selection.levels.len())
                .map(|index| num(selection.factor(index)))
                .collect(),
        ),
    ));
    if selection.factor(level) > 1 {
        fields.push((
            "displayedLevelReduction".to_string(),
            num(selection.factor(level)),
        ));
    }
    if let Some(text) = full.text(file, TAG_PROPERTIES)? {
        let map = properties(&text);
        if !map.is_empty() {
            fields.push(("scannerProperties".to_string(), JsonValue::Obj(map)));
        }
    }

    // Named options are a choice and unnamed ones an axis, as for every
    // other dataset format: the macro photograph is a different picture, a
    // focal plane is a step along Z.
    let mut selectors: Vec<(&str, usize, usize, Option<Vec<&str>>)> = Vec::new();
    if slide.macro_page.is_some() {
        selectors.push((
            "S",
            2,
            usize::from(selection.is_macro),
            Some(vec!["Slide", "Macro"]),
        ));
    }
    if !selection.is_macro && slide.planes.len() > 1 {
        selectors.push(("Z", slide.planes.len(), selection.plane_index, None));
    }
    fields.push((
        "selectors".to_string(),
        JsonValue::Arr(
            selectors
                .iter()
                .map(|(name, size, value, labels)| {
                    let mut entry = vec![
                        ("name".to_string(), JsonValue::Str((*name).to_string())),
                        ("size".to_string(), num(*size as u64)),
                        ("value".to_string(), num(*value as u64)),
                    ];
                    if let Some(labels) = labels {
                        entry.push((
                            "labels".to_string(),
                            JsonValue::Arr(
                                labels
                                    .iter()
                                    .map(|label| JsonValue::Str((*label).to_string()))
                                    .collect(),
                            ),
                        ));
                    }
                    JsonValue::Obj(entry)
                })
                .collect(),
        ),
    ));
    fields.push((
        "selectedIndices".to_string(),
        JsonValue::Obj(
            selectors
                .iter()
                .map(|(name, _, value, _)| ((*name).to_string(), num(*value as u64)))
                .collect(),
        ),
    ));
    Ok(fields)
}

fn check_samples(page: &Page) -> Result<(), DecodeError> {
    if page.compression != COMPRESSION_JPEG {
        return Err(err(format!(
            "compression {} is not supported (only JPEG slides are)",
            page.compression
        )));
    }
    if page.bits != 8 || (page.samples != 1 && page.samples != 3) {
        return Err(err(format!(
            "{} samples of {} bits are not supported",
            page.samples, page.bits
        )));
    }
    Ok(())
}

/// The selected image's size, sample type, pyramid and metadata, as JSON:
/// what a viewer needs before it reads any pixels.
pub(crate) fn ndpi_layout_json(
    file: &NdpiFile<'_>,
    options_json: &str,
) -> Result<String, DecodeError> {
    let options = parse_options(options_json);
    let slide = read_slide(file)?;
    let selection = Selection::new(&slide, &options)?;
    let full = selection.full();
    check_samples(full)?;
    let mut levels = Vec::new();
    let mut channels = full.samples;
    for index in 0..selection.levels.len() {
        let page = selection.page(index)?;
        let header = jpeg_header(file, page)?;
        if index == 0 {
            channels = header.components.min(3);
        }
        let grid = restart_grid(page, &header);
        levels.push(JsonValue::Obj(vec![
            ("factor".to_string(), num(selection.factor(index))),
            ("width".to_string(), num(page.width)),
            ("height".to_string(), num(page.height)),
            ("randomAccess".to_string(), JsonValue::Bool(grid.is_some())),
            (
                "intervalWidth".to_string(),
                num(grid.map_or(page.width, |grid| grid.interval_width)),
            ),
            (
                "intervalHeight".to_string(),
                num(grid.map_or(page.height, |grid| grid.mcu_height)),
            ),
        ]));
    }
    let metadata_json = to_json_string(&JsonValue::Obj(metadata(file, &selection, 0)?));
    Ok(to_json_string(&JsonValue::Obj(vec![
        ("width".to_string(), num(full.width)),
        ("height".to_string(), num(full.height)),
        ("channels".to_string(), num(u64::from(channels))),
        ("bitsPerSample".to_string(), num(8)),
        ("sampleFormat".to_string(), num(1)),
        ("typeMin".to_string(), num(0)),
        ("typeMax".to_string(), num(255)),
        (
            "sourceNumericType".to_string(),
            JsonValue::Str("uint8".to_string()),
        ),
        ("levels".to_string(), JsonValue::Arr(levels)),
        ("metadataJson".to_string(), JsonValue::Str(metadata_json)),
    ])))
}

/// The byte ranges a region decode will read, as
/// `{"x","y","width","height","ranges":[[offset,length],...]}` with the
/// rectangle clamped to the level. Ranges are in file order and merged where
/// they lie close together.
pub(crate) fn ndpi_region_plan_json(
    file: &NdpiFile<'_>,
    options_json: &str,
) -> Result<String, DecodeError> {
    let options = parse_options(options_json);
    let slide = read_slide(file)?;
    let selection = Selection::new(&slide, &options)?;
    let level = options
        .level
        .unwrap_or_else(|| selection.default_level(options.max_pixels));
    let page = selection.page(level)?;
    check_samples(page)?;
    let rect = selection.rect(level, &options)?;
    check_output(rect)?;
    let header = jpeg_header(file, page)?;
    let ranges = match restart_grid(page, &header) {
        Some(grid) => {
            let starts = McuStarts::open(file, page, &header)?;
            coalesce(interval_ranges(&starts, grid, blocks_for(rect, grid))?)
        }
        None => vec![(page.strip_offset, page.strip_len)],
    };
    Ok(to_json_string(&JsonValue::Obj(vec![
        ("level".to_string(), num(level as u64)),
        ("x".to_string(), num(rect.x)),
        ("y".to_string(), num(rect.y)),
        ("width".to_string(), num(rect.width)),
        ("height".to_string(), num(rect.height)),
        (
            "ranges".to_string(),
            JsonValue::Arr(
                ranges
                    .into_iter()
                    .map(|(offset, length)| JsonValue::Arr(vec![num(offset), num(length)]))
                    .collect(),
            ),
        ),
    ])))
}

/// Decode a level, or a rectangle of one, from the ranges `file` holds.
/// `options_json` is `{ indices?: {S?, Z?}, level?, rect?, maxPixels? }`:
/// `S` 1 selects the macro image, `Z` a focal plane, `rect` is in pixels of
/// the level, and a request without `level` gets the finest one within
/// `maxPixels`.
pub(crate) fn decode_ndpi_sparse(
    file: &NdpiFile<'_>,
    options_json: &str,
) -> Result<ScientificParsed, DecodeError> {
    let options = parse_options(options_json);
    let slide = read_slide(file)?;
    let selection = Selection::new(&slide, &options)?;
    let level = options
        .level
        .unwrap_or_else(|| selection.default_level(options.max_pixels));
    let page = selection.page(level)?;
    check_samples(page)?;
    let rect = selection.rect(level, &options)?;
    let decoded = decode_rect(file, page, rect)?;
    let metadata_json = to_json_string(&JsonValue::Obj(metadata(file, &selection, level)?));
    let too_large = || err("image dimension out of range");
    Ok(ScientificParsed {
        width: u32::try_from(decoded.rect.width).map_err(|_| too_large())?,
        height: u32::try_from(decoded.rect.height).map_err(|_| too_large())?,
        channels: decoded.channels,
        bits_per_sample: 8,
        sample_format: 1,
        type_min: 0.0,
        type_max: 255.0,
        source_numeric_type: "uint8".to_string(),
        metadata_json,
        data: decoded.data,
    })
}

/// Decode from a whole file in memory; see [`decode_ndpi_sparse`].
pub(crate) fn decode_ndpi_impl(
    data: &[u8],
    options_json: &str,
) -> Result<ScientificParsed, DecodeError> {
    decode_ndpi_sparse(&NdpiFile::whole(data), options_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "../../test-samples/scientific/synthetic-slide.ndpi";

    fn fixture() -> Vec<u8> {
        std::fs::read(FIXTURE).expect("run scripts/make-ndpi-testdata.py")
    }

    fn pixel(image: &ScientificParsed, x: u32, y: u32) -> [f32; 3] {
        let at = ((y * image.width + x) * image.channels) as usize;
        [image.data[at], image.data[at + 1], image.data[at + 2]]
    }

    fn assert_near(actual: [f32; 3], expected: [f32; 3], what: &str) {
        for channel in 0..3 {
            assert!(
                (actual[channel] - expected[channel]).abs() <= 24.0,
                "{what}: {actual:?} is not near {expected:?}"
            );
        }
    }

    /// Drive a ranged call the way the viewer does: start with nothing, read
    /// each range the decoder asks for, retry. Returns the result and the
    /// pieces read.
    fn ranged<T>(
        size: u64,
        mut pieces: Vec<(u64, Vec<u8>)>,
        read: impl Fn(u64, u64) -> Vec<u8>,
        call: impl Fn(&NdpiFile<'_>) -> Result<T, DecodeError>,
    ) -> (T, Vec<(u64, Vec<u8>)>) {
        for _ in 0..64 {
            let result = {
                let file = NdpiFile::new(
                    size,
                    pieces
                        .iter()
                        .map(|(offset, bytes)| (*offset, bytes.as_slice()))
                        .collect(),
                );
                call(&file)
            };
            match result {
                Ok(value) => return (value, pieces),
                Err(error) => {
                    let message = error.to_string();
                    let request = message
                        .strip_prefix(NEED_RANGE_MARKER)
                        .unwrap_or_else(|| panic!("unexpected error: {message}"));
                    let (offset, rest) = request.split_once(':').unwrap();
                    let length = rest.split_once(']').unwrap().0;
                    let (offset, length): (u64, u64) =
                        (offset.parse().unwrap(), length.parse().unwrap());
                    assert!(length > 0, "an empty range was requested");
                    pieces.push((offset, read(offset, length)));
                }
            }
        }
        panic!("the decoder kept asking for more ranges");
    }

    #[test]
    fn layout_describes_the_pyramid_and_selectors() {
        let data = fixture();
        let layout = parse_json(&ndpi_layout_json(&NdpiFile::whole(&data), "{}").unwrap()).unwrap();
        let number = |value: &JsonValue, key: &str| value.get(key).and_then(JsonValue::as_num);
        assert_eq!(number(&layout, "width"), Some(640.0));
        assert_eq!(number(&layout, "height"), Some(480.0));
        assert_eq!(number(&layout, "channels"), Some(3.0));
        let Some(JsonValue::Arr(levels)) = layout.get("levels") else {
            panic!("no levels");
        };
        assert_eq!(levels.len(), 2);
        assert_eq!(number(&levels[0], "factor"), Some(1.0));
        assert_eq!(number(&levels[0], "intervalWidth"), Some(128.0));
        assert_eq!(number(&levels[0], "intervalHeight"), Some(16.0));
        assert!(matches!(
            levels[0].get("randomAccess"),
            Some(JsonValue::Bool(true))
        ));
        assert_eq!(number(&levels[1], "factor"), Some(4.0));
        assert!(matches!(
            levels[1].get("randomAccess"),
            Some(JsonValue::Bool(false))
        ));

        let metadata = parse_json(
            layout
                .get("metadataJson")
                .and_then(JsonValue::as_str)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            metadata.get("format").and_then(JsonValue::as_str),
            Some("NDPI")
        );
        assert_eq!(
            metadata.get("make").and_then(JsonValue::as_str),
            Some("Hamamatsu")
        );
        // Three characters and a NUL would fit the entry; NDPI stores it out of line.
        assert_eq!(
            metadata.get("slideReference").and_then(JsonValue::as_str),
            Some("S01")
        );
        assert_eq!(number(&metadata, "magnification"), Some(20.0));
        // 20000 pixels per centimetre.
        assert_eq!(number(&metadata, "scalingXUm"), Some(0.5));
        assert_eq!(number(&metadata, "zOffsetNm"), Some(0.0));
        let Some(JsonValue::Arr(selectors)) = metadata.get("selectors") else {
            panic!("no selectors");
        };
        assert_eq!(selectors.len(), 2);
        assert_eq!(
            selectors[0].get("name").and_then(JsonValue::as_str),
            Some("S")
        );
        assert!(selectors[0].get("labels").is_some());
        assert_eq!(
            selectors[1].get("name").and_then(JsonValue::as_str),
            Some("Z")
        );
        assert_eq!(number(&selectors[1], "size"), Some(2.0));
        // The plane at the slide's nominal focus is the default, not plane 0.
        assert_eq!(number(&selectors[1], "value"), Some(1.0));
        assert_eq!(
            metadata
                .get("scannerProperties")
                .and_then(|map| map.get("Product"))
                .and_then(JsonValue::as_str),
            Some("NanoZoomer")
        );
    }

    #[test]
    fn full_level_decodes_the_drawn_picture() {
        let data = fixture();
        let image = decode_ndpi_impl(&data, "{}").unwrap();
        assert_eq!((image.width, image.height, image.channels), (640, 480, 3));
        assert_eq!(image.source_numeric_type, "uint8");
        assert_eq!((image.type_min, image.type_max), (0.0, 255.0));
        assert_near(pixel(&image, 100, 100), [200.0, 40.0, 40.0], "top left");
        assert_near(pixel(&image, 540, 100), [40.0, 180.0, 60.0], "top right");
        assert_near(pixel(&image, 100, 400), [50.0, 70.0, 210.0], "bottom left");
        assert_near(
            pixel(&image, 540, 400),
            [128.0, 128.0, 128.0],
            "bottom right",
        );
        assert_near(pixel(&image, 320, 240), [220.0, 40.0, 220.0], "z=0 marker");
    }

    #[test]
    fn focal_planes_and_the_macro_image_are_selectable() {
        let data = fixture();
        let below = decode_ndpi_impl(&data, r#"{"indices":{"Z":0}}"#).unwrap();
        assert_near(
            pixel(&below, 320, 240),
            [230.0, 220.0, 40.0],
            "z=-1500 marker",
        );
        assert!(below.metadata_json.contains("\"zOffsetNm\":-1500"));

        let macro_image = decode_ndpi_impl(&data, r#"{"indices":{"S":1}}"#).unwrap();
        assert_eq!((macro_image.width, macro_image.height), (180, 60));
        assert_near(pixel(&macro_image, 10, 10), [240.0, 240.0, 235.0], "macro");
        assert_near(
            pixel(&macro_image, 120, 30),
            [120.0, 60.0, 140.0],
            "macro label",
        );

        assert!(decode_ndpi_impl(&data, r#"{"indices":{"Z":2}}"#).is_err());
        assert!(decode_ndpi_impl(&data, r#"{"indices":{"S":2}}"#).is_err());
    }

    #[test]
    fn reduced_level_reports_its_reduction() {
        let data = fixture();
        let image = decode_ndpi_impl(&data, r#"{"level":1}"#).unwrap();
        assert_eq!((image.width, image.height), (160, 120));
        assert_near(pixel(&image, 25, 25), [200.0, 40.0, 40.0], "top left");
        assert!(image
            .metadata_json
            .contains("\"displayedLevelReduction\":4"));
        // Physical size follows the level shown: 0.5 um at 20x, 2 um here.
        assert!(image.metadata_json.contains("\"scalingXUm\":2,"));
        // A pixel budget picks the finest level that fits it.
        let budget = decode_ndpi_impl(&data, r#"{"maxPixels":20000}"#).unwrap();
        assert_eq!((budget.width, budget.height), (160, 120));
    }

    /// The property the pyramid scene depends on: a tile is the same pixels
    /// as that rectangle of the whole level, including along MCU and restart
    /// interval borders where chroma is interpolated.
    #[test]
    fn regions_match_the_whole_level() {
        let data = fixture();
        let whole = decode_ndpi_impl(&data, "{}").unwrap();
        for (x, y, width, height) in [
            (0u32, 0u32, 128u32, 16u32),
            (0, 0, 640, 480),
            (120, 10, 20, 12),
            (255, 239, 2, 2),
            (300, 200, 256, 256),
            (512, 464, 128, 16),
            (639, 479, 1, 1),
            (1, 1, 638, 478),
        ] {
            let options = format!(
                r#"{{"level":0,"rect":{{"x":{x},"y":{y},"width":{width},"height":{height}}}}}"#
            );
            let region = decode_ndpi_impl(&data, &options).unwrap();
            assert_eq!((region.width, region.height), (width, height));
            for row in 0..height {
                let from = (((y + row) * whole.width + x) * 3) as usize;
                let at = (row * width * 3) as usize;
                let run = (width * 3) as usize;
                assert_eq!(
                    &region.data[at..at + run],
                    &whole.data[from..from + run],
                    "region {x},{y} {width}x{height} differs in row {row}"
                );
            }
        }
        // Partly outside: clamped. Wholly outside: an error, not a blank tile.
        let clamped = decode_ndpi_impl(
            &data,
            r#"{"level":0,"rect":{"x":600,"y":470,"width":100,"height":100}}"#,
        )
        .unwrap();
        assert_eq!((clamped.width, clamped.height), (40, 10));
        assert!(decode_ndpi_impl(
            &data,
            r#"{"level":0,"rect":{"x":640,"y":0,"width":10,"height":10}}"#
        )
        .is_err());
    }

    /// Open, plan and decode a tile from ranges alone, as the viewer does.
    #[test]
    fn a_tile_decodes_from_the_planned_ranges() {
        let data = fixture();
        let size = data.len() as u64;
        let read =
            |offset: u64, length: u64| data[offset as usize..(offset + length) as usize].to_vec();
        let options = r#"{"level":0,"rect":{"x":256,"y":160,"width":128,"height":64}}"#;
        let (_, index) = ranged(size, Vec::new(), read, |file| ndpi_layout_json(file, "{}"));
        let (plan, index) = ranged(size, index, read, |file| {
            ndpi_region_plan_json(file, options)
        });
        let plan = parse_json(&plan).unwrap();
        let Some(JsonValue::Arr(ranges)) = plan.get("ranges") else {
            panic!("no ranges");
        };
        assert!(!ranges.is_empty());
        let index_bytes: usize = index.iter().map(|(_, bytes)| bytes.len()).sum();
        let mut pieces = index;
        let mut planned = 0u64;
        for range in ranges {
            let JsonValue::Arr(pair) = range else {
                panic!()
            };
            let (offset, length) = (
                pair[0].as_num().unwrap() as u64,
                pair[1].as_num().unwrap() as u64,
            );
            planned += length;
            pieces.push((offset, read(offset, length)));
        }
        // The tile needs a fraction of the level's JPEG, not all of it.
        assert!(planned < 8000, "planned {planned} bytes");
        assert!(index_bytes as u64 + planned < size);
        let file = NdpiFile::new(
            size,
            pieces
                .iter()
                .map(|(offset, bytes)| (*offset, bytes.as_slice()))
                .collect(),
        );
        // No further request: the plan named everything the decode reads.
        let tile = decode_ndpi_sparse(&file, options).unwrap();
        let whole = decode_ndpi_impl(&data, options).unwrap();
        assert_eq!(tile.data, whole.data);
    }

    /// Slides exceed 4 GiB. Move the first image's JPEG and its restart index
    /// 4 GiB up by setting the high word the NDPI directory keeps for each
    /// entry, and blank the originals: only a reader that honours the high
    /// words, with 64-bit offsets, still finds them.
    #[test]
    fn offsets_above_4_gib_are_followed() {
        const SHIFT: u64 = 1 << 32;
        let original = fixture();
        let expected = decode_ndpi_impl(&original, r#"{"indices":{"Z":0}}"#).unwrap();

        let mut low = original.clone();
        let ifd = u64_le(&low, 4) as usize;
        let count = usize::from(u16_le(&low, ifd));
        let mut moved: Vec<(u64, Vec<u8>)> = Vec::new();
        let strip_len = (0..count)
            .map(|index| ifd + 2 + index * 12)
            .find(|&at| u16_le(&low, at) == TAG_STRIP_BYTE_COUNTS)
            .map(|at| u32_le(&low, at + 8) as usize)
            .unwrap();
        for index in 0..count {
            let at = ifd + 2 + index * 12;
            let tag = u16_le(&low, at);
            let length = match tag {
                TAG_STRIP_OFFSETS => strip_len,
                TAG_MCU_STARTS => u32_le(&low, at + 4) as usize * 4,
                _ => continue,
            };
            let offset = u32_le(&low, at + 8) as usize;
            moved.push((offset as u64 + SHIFT, low[offset..offset + length].to_vec()));
            low[offset..offset + length].fill(0);
            let high_at = ifd + 2 + count * 12 + 8 + index * 4;
            low[high_at..high_at + 4].copy_from_slice(&1u32.to_le_bytes());
        }
        assert_eq!(moved.len(), 2);
        let mut pieces: Vec<(u64, &[u8])> = vec![(0, low.as_slice())];
        pieces.extend(
            moved
                .iter()
                .map(|(offset, bytes)| (*offset, bytes.as_slice())),
        );
        let file = NdpiFile::new(SHIFT + original.len() as u64, pieces);
        let decoded = decode_ndpi_sparse(&file, r#"{"indices":{"Z":0}}"#).unwrap();
        assert_eq!(decoded.data, expected.data);

        // Without the moved pieces the reader asks for them where they now are.
        let missing = NdpiFile::new(SHIFT + original.len() as u64, vec![(0, low.as_slice())]);
        let error = decode_ndpi_sparse(&missing, r#"{"indices":{"Z":0}}"#)
            .err()
            .unwrap()
            .to_string();
        let offset: u64 = error
            .strip_prefix(NEED_RANGE_MARKER)
            .and_then(|rest| rest.split_once(':'))
            .map(|(offset, _)| offset.parse().unwrap())
            .unwrap();
        assert!(offset >= SHIFT, "asked for {offset}");
    }

    #[test]
    fn files_that_are_not_ndpi_are_refused() {
        assert!(decode_ndpi_impl(b"not a slide", "{}").is_err());
        let tiff = std::fs::read("../../test-samples/geotiff_wgs84.tif").unwrap();
        let message = decode_ndpi_impl(&tiff, "{}").err().unwrap().to_string();
        assert!(message.starts_with("NDPI:"), "{message}");
        // A truncated slide fails; it does not panic or ask for bytes past the end.
        let data = fixture();
        for cut in [3usize, 11, 200, data.len() / 2, data.len() - 1] {
            let error = decode_ndpi_impl(&data[..cut], "{}")
                .err()
                .unwrap()
                .to_string();
            assert!(!error.starts_with(NEED_RANGE_MARKER) || cut > 11, "{error}");
        }
    }

    #[test]
    fn close_ranges_are_read_together() {
        assert_eq!(
            coalesce(vec![(1_000_000, 10), (0, 100), (150, 50)]),
            vec![(0, 200), (1_000_000, 10)]
        );
        let scattered: Vec<(u64, u64)> = (0..500).map(|index| (index * 1_000_000, 10)).collect();
        assert!(coalesce(scattered).len() <= MAX_PLANNED_RANGES);
    }
}
