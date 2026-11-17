import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const image = (page: Page) => page.locator('body > canvas:not(.measure-overlay):not(.detail-patch)').first();
async function settle(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function open(page: Page) {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/house.tif'));
  await expect.poll(() => image(page).evaluate((element: HTMLCanvasElement) => element.width)).toBe(512);
  await settle(page);
}
async function scale(page: Page, value: number | 'fit') {
  await page.evaluate(value => window.postMessage({ type: 'setScale', scale: value }, '*'), value);
  await settle(page);
}
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

/** What Ctrl+S downloads, which is the same capture the editor's export dialog saves. */
async function exportedView(page: Page) {
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const file = await download;
  const filePath = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(filePath) };
}

async function expectedFrame(page: Page) {
  return page.evaluate(() => {
    const rect = document.querySelector('body > canvas:not(.measure-overlay):not(.detail-patch)')!.getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--measure-scale-bar-bottom-inset')) || 0;
    const width = Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left);
    const height = Math.min(window.innerHeight - inset, rect.bottom) - Math.max(0, rect.top);
    return { width: Math.floor(width), height: Math.floor(height) };
  });
}

for (const initial of ['fit', 0.5, 4] as const) {
  test(`Ctrl+S downloads the visible part of the image at ${initial}`, async ({ page }) => {
    await open(page); await scale(page, initial);
    const expected = await expectedFrame(page);
    const { name, bytes } = await exportedView(page);
    expect(name).toBe('house.view.png');
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    const size = pngSize(bytes);
    expect(Math.abs(size.width - expected.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(size.height - expected.height)).toBeLessThanOrEqual(1);
    expect(bytes.length).toBeGreaterThan(1000);
  });
}

test('the exported view shows the same pixels as the screen', async ({ page }) => {
  await open(page); await scale(page, 4);
  const origin = await page.evaluate(() => {
    const rect = document.querySelector('body > canvas:not(.measure-overlay):not(.detail-patch)')!.getBoundingClientRect();
    return { left: Math.max(0, rect.left), top: Math.max(0, rect.top) };
  });
  const { bytes } = await exportedView(page);
  // A window in the middle of the view, clear of the header and status bar that the screen shows over the image.
  const area = { x: 300, y: 250, width: 200, height: 150 };
  const screen = await page.screenshot({ clip: area });
  const differing = await page.evaluate(async ([exported, shown, area, origin]) => {
    const decode = async (encoded: string) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]));
      return { bitmap };
    };
    const left = (await decode(exported as string)).bitmap, right = (await decode(shown as string)).bitmap;
    const a = document.createElement('canvas'); a.width = area.width; a.height = area.height;
    a.getContext('2d')!.drawImage(left, area.x - origin.left, area.y - origin.top, area.width, area.height, 0, 0, area.width, area.height);
    const b = document.createElement('canvas'); b.width = area.width; b.height = area.height;
    b.getContext('2d')!.drawImage(right, 0, 0);
    const x = a.getContext('2d')!.getImageData(0, 0, area.width, area.height).data, y = b.getContext('2d')!.getImageData(0, 0, area.width, area.height).data;
    let count = 0;
    for (let at = 0; at < x.length; at += 4) { if (Math.abs(x[at] - y[at]) > 3 || Math.abs(x[at + 1] - y[at + 1]) > 3 || Math.abs(x[at + 2] - y[at + 2]) > 3) { count++; } }
    return count / (area.width * area.height);
  }, [bytes.toString('base64'), screen.toString('base64'), area, origin] as const);
  expect(differing).toBeLessThan(0.03);
});
