#!/usr/bin/env -S uv run --quiet --with numpy --with pillow --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow>=10.2"]
# ///
"""Regenerate the Hamamatsu NDPI fixture in test-samples/scientific/.

`synthetic-slide.ndpi` is a complete NDPI file small enough to commit. Real
slides are hundreds of megabytes, so it reproduces their STRUCTURE rather
than their content:

* the NDPI directory layout: a classic TIFF header whose first-IFD offset is
  eight bytes, IFDs whose next-IFD offset is eight bytes, and the table of
  high-order value/offset bits that follows each IFD;
* one JPEG strip per image, with restart markers and the McuStarts tag
  (65426) that makes the full-resolution level randomly accessible;
* two focal planes (ZOffsetFromSlideCenter -1500 nm and 0 nm), each stored
  at 20x (640x480, 4:2:0, 128-pixel restart intervals) and 5x (160x120, no
  restart markers);
* a macro image (SourceLens -1) and a map image (SourceLens -2).

The picture is four quadrants (red, green, blue, grey) under a 96-pixel
square whose colour identifies the focal plane: yellow at z=0, magenta at
z=1. A +/-12 texture that is constant per 8x8 block lies over all of it, so
every restart interval has its own content while the colours stay close
enough to their nominal values for tests to assert them.

Usage:
    scripts/make-ndpi-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples/scientific relative to this script.
"""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

WIDTH, HEIGHT = 640, 480
RESTART_BLOCKS = 8  # MCUs per restart interval: 8 x 16 px = 128 px at 4:2:0
QUADRANTS = [(200, 40, 40), (40, 180, 60), (50, 70, 210), (128, 128, 128)]
PLANE_MARKERS = [(230, 220, 40), (220, 40, 220)]
Z_OFFSETS_NM = [-1500, 0]

TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 9: 4, 11: 4}


def slide(plane: int) -> np.ndarray:
    image = np.zeros((HEIGHT, WIDTH, 3), np.uint8)
    half_h, half_w = HEIGHT // 2, WIDTH // 2
    image[:half_h, :half_w] = QUADRANTS[0]
    image[:half_h, half_w:] = QUADRANTS[1]
    image[half_h:, :half_w] = QUADRANTS[2]
    image[half_h:, half_w:] = QUADRANTS[3]
    image[192:288, 272:368] = PLANE_MARKERS[plane]
    # A block-constant texture, so a misplaced restart interval is visible to
    # a test instead of vanishing into a flat quadrant.
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    texture = ((xx // 8 * 5 + yy // 8 * 3) % 24).astype(np.int16) - 12
    return np.clip(image.astype(np.int16) + texture[..., None], 0, 255).astype(np.uint8)


def jpeg(image: np.ndarray, restart_blocks: int = 0, subsampling: int = 2) -> bytes:
    out = io.BytesIO()
    options = {"quality": 92, "subsampling": subsampling}
    if restart_blocks:
        options["restart_marker_blocks"] = restart_blocks
    Image.fromarray(image).save(out, "JPEG", **options)
    return out.getvalue()


def mcu_starts(stream: bytes) -> list[int]:
    """Offsets of every restart interval, relative to the start of the stream."""
    at = 2
    while True:
        marker = stream[at + 1]
        length = struct.unpack(">H", stream[at + 2:at + 4])[0]
        at += 2 + length
        if marker == 0xDA:
            break
    starts = [at]
    while at < len(stream) - 1:
        if stream[at] == 0xFF and 0xD0 <= stream[at + 1] <= 0xD7:
            starts.append(at + 2)
            at += 2
        else:
            at += 1
    return starts


class NdpiWriter:
    def __init__(self) -> None:
        self.data = bytearray(b"II*\x00" + bytes(8))
        self.link = 4  # where the offset of the next IFD goes

    def blob(self, payload: bytes) -> int:
        offset = len(self.data)
        self.data += payload
        if len(self.data) % 2:
            self.data += b"\x00"
        return offset

    def ifd(self, tags: list[tuple[int, int, object]]) -> None:
        entries = bytearray()
        high = bytearray()
        for tag, kind, value in sorted(tags, key=lambda item: item[0]):
            if kind == 2:
                payload = value.encode("latin-1") + b"\x00"
                count = len(payload)
            else:
                values = value if isinstance(value, (list, tuple)) else [value]
                count = len(values)
                if kind == 5:
                    count //= 2
                code = {1: "B", 3: "H", 4: "I", 5: "I", 9: "i", 11: "f"}[kind]
                if kind == 4 and count == 1:
                    # A single LONG may exceed 32 bits; its high half is stored
                    # in the table after the IFD.
                    entries += struct.pack("<HHII", tag, kind, 1, values[0] & 0xFFFFFFFF)
                    high += struct.pack("<I", values[0] >> 32)
                    continue
                payload = struct.pack("<" + code * len(values), *values)
            # NDPI stores strings out of line even when they would fit.
            if len(payload) <= 4 and kind != 2:
                entries += struct.pack("<HHI", tag, kind, count) + payload.ljust(4, b"\x00")
                high += bytes(4)
            else:
                offset = self.blob(payload)
                entries += struct.pack("<HHII", tag, kind, count, offset & 0xFFFFFFFF)
                high += struct.pack("<I", offset >> 32)
        offset = self.blob(b"")
        struct.pack_into("<Q", self.data, self.link, offset)
        self.data += struct.pack("<H", len(tags)) + entries
        self.link = len(self.data)
        self.data += bytes(8) + high

    def image(self, stream: bytes, width: int, height: int, lens: float, z_nm: int,
              pixels_per_cm: int, starts: list[int] | None = None,
              samples: int = 3, compression: int = 7) -> None:
        strip = self.blob(stream)
        tags: list[tuple[int, int, object]] = [
            (254, 4, 0), (256, 4, width), (257, 4, height),
            (258, 3, [8] * samples), (259, 3, compression),
            (262, 3, 6 if compression == 7 and samples == 3 else 1),
            (271, 2, "Hamamatsu"), (272, 2, "C9600-12"),
            (273, 4, strip), (277, 3, samples), (278, 4, height), (279, 4, len(stream)),
            (282, 5, [pixels_per_cm, 1]), (283, 5, [pixels_per_cm, 1]), (284, 3, 1), (296, 3, 3),
            (305, 2, "NDP.scan 2.5.90"), (306, 2, "2026:01:15 10:30:00"),
            (65420, 4, 1), (65421, 11, lens),
            (65422, 9, 250000), (65423, 9, -125000), (65424, 9, z_nm),
            (65427, 2, "S01"), (65442, 2, "000000"),
            (65449, 2, "Created=2026/01/15\r\nProduct=NanoZoomer\r\nObjective.Lens.Magnificant=20\r\n"),
        ]
        if starts:
            tags.append((65426, 4, starts))
        self.ifd(tags)


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "test-samples" / "scientific"
    writer = NdpiWriter()
    for plane, z_nm in enumerate(Z_OFFSETS_NM):
        full = slide(plane)
        stream = jpeg(full, RESTART_BLOCKS)
        writer.image(stream, WIDTH, HEIGHT, 20.0, z_nm, 20000, mcu_starts(stream))
        small = np.asarray(Image.fromarray(full).resize((WIDTH // 4, HEIGHT // 4), Image.BOX))
        writer.image(jpeg(small), WIDTH // 4, HEIGHT // 4, 5.0, z_nm, 5000)
    macro = np.zeros((60, 180, 3), np.uint8)
    macro[:] = (240, 240, 235)
    macro[20:40, 100:140] = (120, 60, 140)
    writer.image(jpeg(macro, subsampling=0), 180, 60, -1.0, 0, 400)
    slide_map = (np.arange(40 * 30, dtype=np.uint32).reshape(30, 40) % 251).astype(np.uint8)
    writer.image(slide_map.tobytes(), 40, 30, -2.0, 0, 100, samples=1, compression=1)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "synthetic-slide.ndpi"
    target.write_bytes(bytes(writer.data))
    print(f"Wrote {target} ({len(writer.data)} bytes)")


if __name__ == "__main__":
    main()
