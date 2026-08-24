const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file:///tmp/app-guide-final.html', { waitUntil: 'networkidle' });
  await page.pdf({
    path: '/tmp/Field-Audit-Handbook.pdf',
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });
  await browser.close();
  console.log('done');
})();
