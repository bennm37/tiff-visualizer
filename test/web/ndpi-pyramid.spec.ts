import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A Hamamatsu NDPI slide opens as a pyramid scene from ranged reads
 * (media/modules/ndpi-processor.ts): the stored overview level first, restart
 * intervals of the full-resolution level on zoom.
 *
 * The slide here is written by a JPEG encoder small enough to read: every 8x8
 * block is one flat grey, so a block is a DC difference and an end-of-block
 * code. That makes a 4608x4096 level with 18432 restart intervals, plus its
 * 1/4 overview, in about 300 KB.
 */

class BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private filled = 0;
  write(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit--) {
      this.current = (this.current << 1) | ((value >> bit) & 1);
      if (++this.filled === 8) { this.flush(); }
    }
  }
  private flush(): void {
    this.bytes.push(this.current);
    // A 0xFF data byte is followed by a stuffed zero so it is not a marker.
    if (this.current === 0xff) { this.bytes.push(0); }
    this.current = 0;
    this.filled = 0;
  }
  /** Pad to a byte boundary with one-bits, as a marker requires. */
  align(): void {
    while (this.filled !== 0) { this.write(1, 1); }
  }
  marker(code: number): void {
    this.align();
    this.bytes.push(0xff, code);
  }
  get length(): number { return this.bytes.length; }
  take(): Buffer { this.align(); return Buffer.from(this.bytes); }
}

// The standard luminance DC table: (code, length) per difference category.
const DC_CODES: [number, number][] = [
  [0b00, 2], [0b010, 3], [0b011, 3], [0b100, 3], [0b101, 3], [0b110, 3],
  [0b1110, 4], [0b11110, 5], [0b111110, 6], [0b1111110, 7], [0b11111110, 8], [0b111111110, 9],
];

function writeBlock(bits: BitWriter, difference: number): void {
  const magnitude = Math.abs(difference);
  const category = magnitude === 0 ? 0 : 32 - Math.clz32(magnitude);
  bits.write(...DC_CODES[category]);
  if (category > 0) { bits.write(difference > 0 ? difference : difference + (1 << category) - 1, category); }
  bits.write(0b00, 2); // end of block
}

/**
 * A baseline greyscale JPEG whose 8x8 blocks are flat. `restartInterval` 0
 * writes no restart markers; otherwise `starts` receives the offset of every
 * interval from the start of the stream, which is what McuStarts holds.
 */
function flatJpeg(width: number, height: number, restartInterval: number, level: (blockX: number, blockY: number) => number, starts: number[]): Buffer {
  const segment = (marker: number, body: number[]) => Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
  const header = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    // Quantisation step 8 for DC makes the DC coefficient `grey - 128`.
    segment(0xdb, [0, 8, ...new Array(63).fill(1)]),
    segment(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]),
    segment(0xc4, [0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    // AC: two codes of length 2; only end-of-block (code 00) is ever written.
    segment(0xc4, [0x10, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01]),
    ...(restartInterval ? [segment(0xdd, [restartInterval >> 8, restartInterval & 255])] : []),
    segment(0xda, [1, 1, 0x00, 0, 63, 0]),
  ]);
  const bits = new BitWriter();
  const columns = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  let previous = 0, count = 0;
  for (let blockY = 0; blockY < rows; blockY++) {
    for (let blockX = 0; blockX < columns; blockX++) {
      if (restartInterval && count % restartInterval === 0) {
        if (count > 0) { bits.marker(0xd0 + ((count / restartInterval - 1) % 8)); }
        starts.push(header.length + bits.length);
        previous = 0;
      }
      const dc = level(blockX, blockY) - 128;
      writeBlock(bits, dc - previous);
      previous = dc;
      count++;
    }
  }
  return Buffer.concat([header, bits.take(), Buffer.from([0xff, 0xd9])]);
}

/** An NDPI file: 8-byte IFD offsets, and a high-bits word per entry after each IFD. */
function ndpi(images: { jpeg: Buffer, width: number, height: number, lens: number, starts: number[], pixelsPerCm?: number }[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0].write('II*\0', 0, 'latin1');
  let size = 12;
  let link = { part: 0, at: 4 };
  const append = (data: Buffer) => { const offset = size; parts.push(data); size += data.length; return offset; };
  for (const image of images) {
    const strip = append(image.jpeg);
    const lens = Buffer.alloc(4);
    lens.writeFloatLE(image.lens);
    const entries: [number, number, number, number][] = [
      [256, 4, 1, image.width], [257, 4, 1, image.height], [258, 3, 1, 8], [259, 3, 1, 7], [262, 3, 1, 1],
      [273, 4, 1, strip], [277, 3, 1, 1], [278, 4, 1, image.height], [279, 4, 1, image.jpeg.length],
      [65420, 4, 1, 1], [65421, 11, 1, lens.readUInt32LE(0)], [65424, 9, 1, 0],
    ];
    if (image.pixelsPerCm) {
      const resolution = Buffer.alloc(8);
      resolution.writeUInt32LE(image.pixelsPerCm, 0);
      resolution.writeUInt32LE(1, 4);
      const at = append(resolution);
      entries.push([282, 5, 1, at], [283, 5, 1, at], [296, 3, 1, 3]);
      entries.sort((a, b) => a[0] - b[0]);
    }
    if (image.starts.length) {
      const table = Buffer.alloc(image.starts.length * 4);
      image.starts.forEach((start, index) => table.writeUInt32LE(start, index * 4));
      entries.push([65426, 4, image.starts.length, append(table)]);
    }
    const ifd = Buffer.alloc(2 + entries.length * 12 + 8 + entries.length * 4);
    ifd.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], index) => {
      ifd.writeUInt16LE(tag, 2 + index * 12);
      ifd.writeUInt16LE(type, 4 + index * 12);
      ifd.writeUInt32LE(count, 6 + index * 12);
      ifd.writeUInt32LE(value, 10 + index * 12);
    });
    const offset = append(ifd);
    parts[link.part].writeUInt32LE(offset, link.at);
    link = { part: parts.length - 1, at: 2 + entries.length * 12 };
  }
  return Buffer.concat(parts);
}

/** Grey of the full-resolution pixel block at (x, y): constant over 128x32 pixels. */
const grey = (x: number, y: number) => 30 + ((Math.floor(x / 128) * 37 + Math.floor(y / 32) * 11) % 200);

function sparseSlide(): Buffer {
  const starts: number[] = [];
  const full = flatJpeg(4608, 4096, 16, (blockX, blockY) => grey(blockX * 8, blockY * 8), starts);
  const quarter = flatJpeg(1152, 1024, 0, (blockX, blockY) => grey(blockX * 32, blockY * 32), []);
  return ndpi([
    // 20000 pixels per centimetre: 0.5 um per full-resolution pixel.
    { jpeg: full, width: 4608, height: 4096, lens: 20, starts, pixelsPerCm: 20000 },
    { jpeg: quarter, width: 1152, height: 1024, lens: 5, starts: [], pixelsPerCm: 5000 },
  ]);
}

test('a large NDPI slide opens as a pyramid scene and refines on zoom', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('sparse-slide.ndpi');
  fs.writeFileSync(file, sparseSlide());
  const logs: string[] = [];
  const errors: string[] = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(file);
  const scene = page.locator('.pyramid-scene');
  await expect(scene).toBeVisible({ timeout: 15000 });
  await expect(scene).toHaveAttribute('data-scene-width', '4608');
  await expect(scene).toHaveAttribute('data-scene-height', '4096');
  // The base canvas is the stored 1/4 level, not a decode of the whole slide.
  const base = scene.locator('canvas.pyramid-base');
  await expect(base).toHaveJSProperty('width', 1152);
  await expect(base).toHaveJSProperty('height', 1024);
  expect(logs.some(line => line.includes('ranged read failed'))).toBe(false);
  await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 1 }, '*'));
  await expect.poll(() => logs.some(line => line.includes('[Tiles] painted Full')), { timeout: 15000 }).toBe(true);
  // A full-resolution tile holds the picture drawn for its place on the slide.
  const tile = scene.locator('canvas.pyramid-tile').first();
  await expect(tile).toBeVisible();
  const sample = await tile.evaluate((canvas: HTMLCanvasElement, sceneWidth: number) => {
    const x = Math.round(parseFloat(canvas.style.left) / 100 * sceneWidth);
    const y = Math.round(parseFloat(canvas.style.top) / 100 * 4096);
    const pixel = canvas.getContext('2d')!.getImageData(5, 5, 1, 1).data;
    return { x: x + 5, y: y + 5, value: pixel[0] };
  }, 4608);
  expect(Math.abs(sample.value - grey(sample.x, sample.y))).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('ROIs draw on an NDPI scene and measure in its calibrated units', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('sparse-slide.ndpi');
  fs.writeFileSync(file, sparseSlide());
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(file);
  const scene = page.locator('.pyramid-scene');
  await expect(scene).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => window.postMessage({ type: 'toggleMeasure' }, '*'));
  const panel = page.locator('.measure-panel');
  await expect(panel).toBeVisible();

  // An ROI lives on the loaded 1/4 overview (1152x1024). Each of its pixels
  // is 2 um wide, so 100x50 pixels measure 200 um x 100 um.
  const roi = { kind: 'rect', id: 'known', name: 'Known', x: 400, y: 300, width: 100, height: 50 };
  await page.evaluate(roi => window.postMessage({
    type: 'measureImportResult', kind: 'sidecar',
    bytes: Array.from(new TextEncoder().encode(JSON.stringify({ version: 1, rois: [roi] }))),
  }, '*'), roi);
  await panel.locator('.measure-tab').getByText('Results', { exact: true }).click();
  const row = panel.locator('.measure-results-wrapper tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(3)).toHaveText('600');

  // The outline is painted where that rectangle lies on the scene.
  const painted = (inside: boolean) => page.evaluate(({ roi, inside }) => {
    const sceneRect = document.querySelector('.pyramid-scene')!.getBoundingClientRect();
    const overlay = document.querySelector('canvas.measure-overlay') as HTMLCanvasElement;
    const overlayRect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / overlayRect.width, scaleY = overlay.height / overlayRect.height;
    const clientX = sceneRect.left + ((inside ? roi.x + roi.width / 2 : roi.x) / 1152) * sceneRect.width;
    const clientY = sceneRect.top + ((roi.y + roi.height / 2) / 1024) * sceneRect.height;
    const data = overlay.getContext('2d')!.getImageData(
      Math.round((clientX - overlayRect.left) * scaleX) - 3, Math.round((clientY - overlayRect.top) * scaleY) - 3, 7, 7).data;
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) { if (data[index] > 200) { opaque++; } }
    return opaque;
  }, { roi, inside });
  await expect.poll(() => painted(false)).toBeGreaterThan(0);

  // Drawing with the pointer adds an ROI too.
  await panel.locator('.measure-tab').getByText('Tools', { exact: true }).click().catch(() => undefined);
  await panel.getByRole('button', { name: 'Rect', exact: true }).click();
  const box = (await scene.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await panel.locator('.measure-tab').getByText('Results', { exact: true }).click();
  await expect(row).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('the NDPI fixture offers its focal planes and macro image', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/scientific/synthetic-slide.ndpi'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 15000 });
  const canvas = page.locator('canvas.scale-to-fit, canvas.pixelated').first();
  await expect(canvas).toHaveJSProperty('width', 640);
  // Small enough to decode whole: no scene, but the Z axis and the image choice.
  await expect(page.locator('.pyramid-scene')).toHaveCount(0);
  const overlay = page.locator('.dataset-overlay');
  await expect(overlay.locator('input[type=range]').first()).toBeVisible();
  await expect(overlay.locator('select')).toContainText('Macro');
  await overlay.locator('select').selectOption({ label: 'Macro' });
  await expect.poll(async () => page.locator('canvas.scale-to-fit, canvas.pixelated').first().evaluate((node: HTMLCanvasElement) => node.width)).toBe(180);
  expect(errors).toEqual([]);
});
