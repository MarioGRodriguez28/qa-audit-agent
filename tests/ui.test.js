const { chromium } = require('playwright');
const { createApp } = require('../src/server');
const { auditFrontend } = require('../src/frontend');

jest.setTimeout(90000);

const XSS = '<img src=x onerror="window.__xss = 1">';
const RESULT = {
  kind: 'api',
  target: 'https://api.example.com',
  specTitle: 'Pets API',
  scannedAt: '2026-10-05T00:00:00.000Z',
  endpoints: [
    { endpoint: 'GET /pets', status: 500, durationMs: 120, issues: 1 },
    { endpoint: 'GET /pets/{id}', status: null, durationMs: 8000, issues: 1 },
  ],
  findings: [
    { id: 'LOW', severity: 'low', endpoint: 'API', title: 'Missing header', detail: 'nosniff' },
    { id: 'HIGH', severity: 'high', endpoint: 'GET /pets', title: `Server error ${XSS}`, detail: `Returned 500 ${XSS}` },
  ],
  score: 78,
  grade: 'B',
};

const SUITE = {
  kind: 'suite',
  target: 'https://acme.example/',
  specTitle: 'Acme',
  scannedAt: '2026-10-05T00:00:00.000Z',
  score: 90,
  grade: 'A',
  summary: { total: 10, passed: 9, failed: 1, skipped: 0 },
  site: { pages: 3, forms: 1, links: 5, apiCalls: 1, skipped: 0, authRequired: false },
  tests: [],
  endpoints: [{ endpoint: 'GET /', status: 200, durationMs: 100, issues: 0 }],
  findings: [{ id: 'x', severity: 'medium', endpoint: 'GET /a', title: 'Page structure: /a', detail: '0 h1 headings (expected 1)' }],
};

let server;
let browser;
let base;
let calls;

beforeAll(async () => {
  calls = [];
  server = createApp({
    runAudit: async (request) => {
      calls.push(request);
      if (request.target.includes('refused')) throw new Error('Refusing to audit a local host');
      if (request.type === 'explore') return { ...SUITE, exportedSpec: '// generated spec' };
      return RESULT;
    },
    summarizeFn: async () => ({ text: 'Summary text', source: 'template' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

async function openPage() {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(base);
  return page;
}

describe('audit interface', () => {
  it('runs an audit and shows score, findings sorted by severity and requests', async () => {
    const page = await openPage();
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();

    await page.locator('#results').waitFor({ state: 'visible' });
    expect(await page.locator('#score').innerText()).toBe('78');
    expect(await page.locator('#grade').innerText()).toBe('B');
    expect(await page.locator('#summary').innerText()).toBe('Summary text');
    const badges = await page.locator('.findings .badge').allInnerTexts();
    expect(badges.map((b) => b.toLowerCase())).toEqual(['high', 'low']);
    expect(await page.locator('#requests tr').count()).toBe(2);
    expect(await page.locator('#requests tr').nth(1).innerText()).toContain('error');
    expect(calls.at(-1)).toMatchObject({ type: 'api', target: 'https://api.example.com/openapi.json' });
    await page.waitForFunction(() => document.getElementById('marker').style.getPropertyValue('--p') === '78');
    expect(await page.locator('#ruler .zones li.on').innerText()).toBe('B');
    expect(await page.locator('#requests .tl').evaluateAll((bars) => bars.map((b) => b.className))).toEqual(['tl s5', 'tl err']);
    await page.context().close();
  });

  it('shows untrusted audit data as plain text and never runs it', async () => {
    const page = await openPage();
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();
    await page.locator('#score').waitFor();

    expect(await page.locator('.findings').innerText()).toContain('<img src=x');
    expect(await page.locator('.findings img').count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await page.context().close();
  });

  it('switches to web mode, hides the base URL field and uses the example', async () => {
    const page = await openPage();
    await page.locator('label[for="type-web"]').click();
    expect(await page.getByLabel('Web page in a real browser').isChecked()).toBe(true);

    expect(await page.locator('#base-field').isHidden()).toBe(true);
    await page.getByRole('button', { name: 'Try example.com' }).click();
    expect(await page.locator('#target').inputValue()).toBe('https://example.com');
    await page.getByRole('button', { name: 'Run audit' }).click();
    await page.locator('#score').waitFor();
    expect(calls.at(-1)).toMatchObject({ type: 'web', target: 'https://example.com/' });
    await page.context().close();
  });

  it('crawls a site, shows the generated suite and offers the spec for download', async () => {
    const page = await openPage();
    expect(await page.locator('#download-spec').isHidden()).toBe(true);
    await page.locator('label[for="type-explore"]').click();
    await page.getByRole('button', { name: 'Try a practice site' }).click();
    expect(await page.locator('#target').inputValue()).toBe('https://quotes.toscrape.com/');
    await page.getByRole('button', { name: 'Run audit' }).click();
    await page.locator('#results').waitFor({ state: 'visible' });

    expect(await page.locator('#r-type').innerText()).toBe('Generated suite');
    expect(await page.locator('#r-count').innerText()).toBe('9/10 passed');
    expect(await page.locator('#findings-title').textContent()).toContain('Failed tests');
    expect(await page.locator('#requests-title').textContent()).toBe('Pages explored');
    expect(calls.at(-1)).toMatchObject({ type: 'explore' });
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download generated.spec.js' }).click()]);
    expect(download.suggestedFilename()).toBe('generated.spec.js');
    await page.context().close();
  });

  it('shows server errors in an alert and keeps the form usable', async () => {
    const page = await openPage();
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://refused.example.com/spec.json');
    await page.getByRole('button', { name: 'Run audit' }).click();

    await expect(page.getByRole('alert').innerText()).resolves.toContain('Refusing to audit');
    expect(await page.getByRole('button', { name: 'Run audit' }).isEnabled()).toBe(true);
    expect(await page.locator('#results').isHidden()).toBe(true);
    await page.context().close();
  });

  it('explains when the server answers with something that is not JSON', async () => {
    const page = await openPage();
    await page.route('**/api/audit', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<!doctype html><title>Bad gateway</title>' }));
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();

    await expect(page.getByRole('alert').innerText()).resolves.toContain('did not answer with JSON (status 502)');
    await page.context().close();
  });

  it('explains that the server may have stopped when the connection fails', async () => {
    const page = await openPage();
    await page.route('**/api/audit', (route) => route.abort('connectionrefused'));
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();

    await expect(page.getByRole('alert').innerText()).resolves.toContain('npm run ui');
    expect(await page.getByRole('button', { name: 'Run audit' }).isEnabled()).toBe(true);
    await page.context().close();
  });

  it('asks for a URL instead of sending an empty request', async () => {
    const page = await openPage();
    const before = calls.length;
    await page.getByRole('button', { name: 'Run audit' }).click();

    await expect(page.getByRole('alert').innerText()).resolves.toContain('Enter a URL');
    expect(calls.length).toBe(before);
    await page.context().close();
  });

  it('downloads the report as markdown', async () => {
    const page = await openPage();
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();
    await page.locator('#score').waitFor();

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report.md' }).click()]);

    expect(download.suggestedFilename()).toBe('report.md');
    await page.context().close();
  });

  it('disables the AI option when the server has no key', async () => {
    const page = await openPage();
    await page.locator('#ai-help').waitFor({ state: 'visible' });

    expect(await page.locator('#ai').isDisabled()).toBe(true);
    await page.context().close();
  });

  it('does not overflow horizontally on a phone, with results on screen', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await context.newPage();
    await page.goto(base);
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();
    await page.locator('#results').waitFor({ state: 'visible' });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('.finding-title').first().evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(150);
    await context.close();
  });

  it('has no unexpected requests or console errors while loading and running', async () => {
    const page = await openPage();
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
    await page.reload();
    await page.getByLabel('OpenAPI spec URL (JSON)').fill('https://api.example.com/openapi.json');
    await page.getByRole('button', { name: 'Run audit' }).click();
    await page.locator('#results').waitFor({ state: 'visible' });

    expect(problems).toEqual([]);
    await page.context().close();
  });

  it.each(['light', 'dark'])('passes its own web audit in %s mode with no medium or high findings', async (colorScheme) => {
    const result = await auditFrontend({ url: base, allowLocal: true, contextOptions: { colorScheme } });

    expect(result.findings.filter((f) => ['high', 'medium'].includes(f.severity))).toEqual([]);
  });
});
