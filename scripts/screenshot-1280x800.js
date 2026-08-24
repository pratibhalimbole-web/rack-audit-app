const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2] || 'https://rack-audit-app.vercel.app';
  const outPath = process.argv[3] || '/tmp/rack-audit-1280x800.png';

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outPath });
  await browser.close();
  console.log('Saved:', outPath);
})();
