// r9：字型改為同源（不再連線 Google Fonts）
//   R9-01  原始頁與 dist 頁：零個外部字型請求；fonts/fonts.css 200；IBM Plex Mono／Syne 可載入
//   R9-02  dist CSP：font-src 只允許 'self'；style-src 不含任何外部網域
//   （人聲分離略過的畫面提示：併入 round15-r8 的 R8-07）
import { test, expect } from '@playwright/test';
import { BASE_URL } from './harness';

const DIST_URL = process.env.WHISPER_DIST_TEST_URL ?? 'http://localhost:8081/index.html';

for (const [label, url] of [['原始頁', BASE_URL], ['dist', DIST_URL]] as const) {
  test(`R9-01 ${label}：不連線外部字型網域，字型由同源載入`, async ({ page }) => {
    const external: string[] = []; let cssStatus = 0;
    page.on('request', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) external.push(r.url()); });
    page.on('response', (r) => { if (r.url().endsWith('/fonts/fonts.css')) cssStatus = r.status(); });
    await page.goto(url);
    const ok = await page.evaluate(async () => {
      const a = await document.fonts.load('600 12px "IBM Plex Mono"', 'Ab');
      const b = await document.fonts.load('800 12px "Syne"', 'Ab');
      return a.length > 0 && b.length > 0;
    });
    expect(external).toEqual([]);
    expect(cssStatus).toBe(200);
    expect(ok).toBe(true);
  });
}

test('R9-02 dist CSP：font-src 只允許 self，style-src 無外部網域', async ({ page }) => {
  await page.goto(DIST_URL);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toMatch(/font-src 'self'(;|$)/);
  const style = (csp || '').split(';').map((d) => d.trim()).find((d) => d.startsWith('style-src')) || '';
  expect(style).not.toMatch(/https?:/);
});
