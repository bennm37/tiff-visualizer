import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const module = buildSync({ entryPoints: [path.join(root, 'media/modules/viewer-focus.ts')], bundle: true, format: 'iife', globalName: 'ViewerFocus', write: false }).outputFiles[0].text;

/**
 * Two webviews side by side, as in a split editor. The second cancels every
 * press the way the pan and drag handlers do, which keeps the browser from
 * moving focus into its frame unless the page claims it.
 */
async function pressInSecond(claim: boolean, page: import('@playwright/test').Page) {
  const frame = (script: string) => `<body style="margin:0;height:400px;background:#ccc"><script>${script}</script></body>`.replace(/"/g, '&quot;');
  const cancelling = `document.addEventListener('mousedown', e => e.preventDefault());`;
  const claiming = claim ? `${module}; ViewerFocus.installFocusClaim();` : '';
  await page.setViewportSize({ width: 900, height: 400 });
  await page.setContent(`<body style="margin:0"><iframe id="a" srcdoc="${frame('')}" style="width:380px;height:400px;border:0"></iframe>`
    + `<iframe id="b" srcdoc="${frame(claiming + cancelling)}" style="width:380px;height:400px;border:0;margin-left:20px"></iframe>`);
  await page.mouse.click(100, 200);
  expect(await page.evaluate(() => (document.getElementById('a') as HTMLIFrameElement).contentDocument!.hasFocus())).toBe(true);
  await page.mouse.move(600, 200); await page.mouse.down(); await page.mouse.move(640, 220, { steps: 4 }); await page.mouse.up();
  return page.evaluate(() => ({
    first: (document.getElementById('a') as HTMLIFrameElement).contentDocument!.hasFocus(),
    second: (document.getElementById('b') as HTMLIFrameElement).contentDocument!.hasFocus(),
  }));
}

test('a press the page cancels does not move focus into its webview by itself', async ({ page }) => {
  expect(await pressInSecond(false, page)).toEqual({ first: true, second: false });
});

test('claiming focus in the capture phase moves it even when the press is cancelled', async ({ page }) => {
  expect(await pressInSecond(true, page)).toEqual({ first: false, second: true });
});
