const { chromium } = require('playwright');

(async () => {
  const targetUrl = process.argv[2];
  const captureId = process.argv[3];
  const endpoint = process.argv[4];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    await route.fulfill({ response, headers });
  });

  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  const scriptText = await page.context().request.get('https://mcp.figma.com/mcp/html-to-design/capture.js').then(r => r.text());
  await page.evaluate((s) => {
    const el = document.createElement('script');
    el.textContent = s;
    document.head.appendChild(el);
  }, scriptText);

  await page.waitForTimeout(500);

  const result = await page.evaluate(({ captureId, endpoint }) => {
    return window.figma.captureForDesign({ captureId, endpoint, selector: 'body' });
  }, { captureId, endpoint });

  console.log(JSON.stringify(result));
  await browser.close();
})().catch((err) => {
  console.error('CAPTURE_ERROR', err);
  process.exit(1);
});
