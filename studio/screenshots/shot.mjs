// Screenshot helper.
// node screenshots/shot.mjs <url> <out.png> [width] [height] [--click "<row text>"] [--hover "<css selector>"] [--eval "<js>"]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [url, out, w = '1280', h = '900'] = positional;
const clickRow = flag('--click');
const hover = flag('--hover');
const evalJs = flag('--eval');

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(3000);
if (clickRow) {
  await page.locator('.ag-row', { hasText: clickRow }).first().click();
  await page.waitForTimeout(2000);
}
if (hover) {
  await page.locator(hover).first().hover();
  await page.waitForTimeout(400);
}
if (evalJs) {
  await page.evaluate(evalJs);
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out, timeout: 60000, animations: 'disabled' });
await browser.close();
console.log('saved', out);
