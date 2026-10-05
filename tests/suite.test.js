const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createSite } = require('./site');
const { explore } = require('../src/explore');
const { generateTests, createBaseline } = require('../src/generate');
const { runSuite } = require('../src/runner');
const { exportPlaywrightSpec } = require('../src/export');
const { toMarkdown } = require('../src/report');

jest.setTimeout(180000);
const run = promisify(execFile);
const ROOT = path.join(__dirname, '..');

let site;
let base;

beforeAll(async () => {
  site = createSite();
  await new Promise((resolve) => site.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.server.address().port}/`;
});

afterAll(() => new Promise((resolve) => site.server.close(resolve)));

beforeEach(() => {
  site.state.variant = 'v1';
  site.state.posts.length = 0;
  site.state.hits.length = 0;
});

const crawl = (options = {}) => explore({ url: base, allowLocal: true, ...options });
const paths = (model) => model.pages.map((p) => new URL(p.url).pathname).sort();
const count = (cases, type) => cases.filter((c) => c.type === type).length;
const failedNames = (result) => result.tests.filter((t) => t.status === 'failed').map((t) => t.name).sort();

describe('explore', () => {
  it('maps pages, forms and API calls, and skips destructive and file links', async () => {
    const model = await crawl();

    expect(paths(model)).toEqual(['/', '/about', '/broken', '/contact', '/missing', '/products']);
    expect(model.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'destructive or sign-out path' }),
        expect.objectContaining({ reason: 'file' }),
      ]),
    );
    const contact = model.pages.find((p) => p.url.endsWith('/contact'));
    expect(contact.forms[0].fields.map((f) => f.name)).toEqual(['name', 'email', 'age', 'topic', 'message']);
    expect(contact.forms[0].fields.find((f) => f.name === 'email')).toMatchObject({ type: 'email', required: true });
    const products = model.pages.find((p) => p.url.endsWith('/products'));
    expect(products.apiCalls[0].shape.item.keys).toEqual({ id: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number' } });
    expect(model.pages.find((p) => p.url.endsWith('/missing')).from).toBe(base);
  });

  it('honours the page limit and the depth', async () => {
    expect(paths(await crawl({ maxPages: 2 }))).toHaveLength(2);
    expect(paths(await crawl({ depth: 0 }))).toEqual(['/']);
  });

  it('says clearly when the start page cannot be loaded or returns an error', async () => {
    await expect(explore({ url: 'http://127.0.0.1:9/', allowLocal: true, timeoutMs: 3000 })).rejects.toThrow(/Could not load the start page/);
    await expect(explore({ url: `${base}nothing-here`, allowLocal: true })).rejects.toThrow('The start page returned status 404');
  });

  it('refuses a private target before launching a browser', async () => {
    const launch = jest.fn();

    await expect(explore({ url: 'http://127.0.0.1:9/', launch })).rejects.toThrow(/local|private/i);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('generated suite', () => {
  it('derives the expected tests from what it found', async () => {
    const cases = generateTests(await crawl());

    expect(cases).toHaveLength(28);
    expect(count(cases, 'page-loads')).toBe(6);
    expect(count(cases, 'page-structure')).toBe(5);
    expect(count(cases, 'page-a11y')).toBe(5);
    expect(count(cases, 'nav-click')).toBe(3);
    expect(count(cases, 'form-required')).toBe(1);
    expect(count(cases, 'form-validation')).toBe(5);
    expect(count(cases, 'form-accepts-valid')).toBe(1);
    expect(count(cases, 'api-contract')).toBe(1);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('finds the defects of the site, passes the rest, and never writes or signs out', async () => {
    const model = await crawl();
    const result = await runSuite({ model, cases: generateTests(model), allowLocal: true });

    expect(failedNames(result)).toEqual([
      'No serious accessibility violations: /broken',
      'Page loads without errors: /broken',
      'Page loads without errors: /missing',
      'Page structure (one h1, lang, viewport): /broken',
    ]);
    expect(result.summary).toMatchObject({ total: 28, failed: 4, passed: 24 });
    expect(result.score).toBe(86);
    expect(result.findings).toHaveLength(4);
    expect(site.state.posts).toEqual([]);
    expect(site.state.hits.some((h) => h.includes('logout'))).toBe(false);
  });

  it('writes a report with the failed tests first', async () => {
    const model = await crawl();
    const result = await runSuite({ model, cases: generateTests(model), allowLocal: true });
    const md = toMarkdown(result, 'Summary text');

    expect(md).toContain('# Generated test suite: Acme Demo');
    expect(md.indexOf('## Failed tests')).toBeLessThan(md.indexOf('## All tests'));
    expect(md).toContain('linked from /');
    expect(md).toContain('| FAIL |');
  });

  it('reports a problem repeated on many pages once, with the pages it affects', async () => {
    const test = (name, url) => ({ type: 'page-structure', group: 'page', name, url: `http://x.test${url}`, status: 'failed', detail: 'missing viewport meta tag', durationMs: 1 });
    const tests = ['/a', '/b', '/c', '/d', '/e', '/f'].map((p) => test(`Page structure: ${p}`, p));
    tests.push({ ...test('Page structure: /solo', '/solo'), detail: '0 h1 headings (expected 1)' });
    const result = {
      kind: 'suite', specTitle: 'X', target: 'http://x.test/', scannedAt: 'now', score: 0, grade: 'F',
      summary: { total: 7, passed: 0, failed: 7, skipped: 0 },
      site: { pages: 7, forms: 0, links: 0, apiCalls: 0, skipped: 0, authRequired: true },
      tests, endpoints: [],
    };
    const md = toMarkdown(result, 's');

    expect(md).toContain('Affects 6 pages: /a, /b, /c, /d and 2 more.');
    expect(md).toContain('Page structure: /solo. 0 h1 headings');
    const failedSection = md.slice(md.indexOf('## Failed tests'), md.indexOf('## All tests'));
    expect(failedSection.match(/missing viewport meta tag/g)).toHaveLength(1);
    expect(md).toContain('redirected to a login page');
  });

  it('saves a screenshot for failures when given an output folder', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-'));
    const model = await crawl();
    const result = await runSuite({ model, cases: generateTests(model), allowLocal: true, outDir: out });
    const shot = result.tests.find((t) => t.status === 'failed').screenshot;

    expect((await fs.stat(path.join(out, shot))).size).toBeGreaterThan(0);
  });
});

describe('baseline regression', () => {
  it('detects removed pages, changed titles, removed links and a changed API shape', async () => {
    const baseline = createBaseline(await crawl());
    site.state.variant = 'v2';
    const model = await crawl();
    const result = await runSuite({ model, cases: generateTests(model, { baseline }), allowLocal: true });
    const test = (name) => result.tests.find((t) => t.name === name);

    expect(test('Baseline: /about is unchanged').detail).toContain('title changed');
    expect(test('Baseline: /contact is unchanged').detail).toContain('not reachable');
    expect(test('Baseline: / is unchanged').detail).toContain('links removed: /contact');
    const api = result.tests.find((t) => t.type === 'api-contract');
    expect(api.status).toBe('failed');
    expect(api.detail).toContain('differs from the baseline');
  });

  it('reports no baseline differences when nothing changed', async () => {
    const baseline = createBaseline(await crawl());
    const model = await crawl();
    const result = await runSuite({ model, cases: generateTests(model, { baseline }), allowLocal: true });

    expect(result.tests.filter((t) => t.group === 'baseline').length).toBeGreaterThan(0);
    expect(result.tests.filter((t) => t.group === 'baseline' && t.status !== 'passed')).toEqual([]);
  });
});

describe('exported Playwright spec', () => {
  it('runs on its own and agrees with the tool about what passes and fails', async () => {
    const model = await crawl();
    const cases = generateTests(model);
    const inTool = failedNames(await runSuite({ model, cases, allowLocal: true }));

    // Playwright honours .gitignore, so the spec runs from a temp folder outside the repo.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'export-'));
    await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'export-check.spec.js'), exportPlaywrightSpec(cases, model));
    // Playwright refuses to start when it detects it is inside a Jest worker.
    const { JEST_WORKER_ID, NODE_ENV, ...env } = process.env;
    let stdout;
    try {
      ({ stdout } = await run(path.join(ROOT, 'node_modules', '.bin', 'playwright'), ['test', 'export-check.spec.js', '--reporter=json'], {
        cwd: dir,
        env: { ...env, BASE_URL: base.replace(/\/$/, '') },
        maxBuffer: 20_000_000,
      }));
    } catch (error) {
      stdout = error.stdout;
    }
    const specs = [];
    const walk = (suite) => {
      (suite.specs || []).forEach((s) => specs.push(s));
      (suite.suites || []).forEach(walk);
    };
    JSON.parse(stdout).suites.forEach(walk);
    const exportedFailed = specs.filter((s) => !s.ok).map((s) => s.title).sort();
    await fs.rm(dir, { recursive: true, force: true });

    expect(specs).toHaveLength(28);
    expect(exportedFailed).toEqual(inTool);
  });
});

describe('explore command', () => {
  it('writes the report, model, exported spec and baseline, and uses the baseline next time', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-'));
    const cli = (...args) =>
      run('node', ['src/cli.js', 'explore', base, '--allow-local', '--no-ai', '--out', out, ...args], { cwd: ROOT }).catch((e) => e);

    const first = await cli();
    expect(first.code).toBe(2);
    expect(first.stdout).toContain('baseline saved');
    for (const file of ['report.md', 'report.json', 'site-model.json', 'generated.spec.js', 'baseline.json']) {
      expect((await fs.stat(path.join(out, file))).size).toBeGreaterThan(0);
    }
    await cli();
    const second = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));

    expect(second.tests.some((t) => t.group === 'baseline')).toBe(true);
  });
});
