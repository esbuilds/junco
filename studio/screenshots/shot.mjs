// Screenshot helper: node screenshots/shot.mjs <url> <out.png> [width] [height]
import { chromium } from 'playwright';

const [url, out, w = '1280', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(6000);
await page.screenshot({ path: out, timeout: 60000, animations: 'disabled' });
await browser.close();
console.log('saved', out);
