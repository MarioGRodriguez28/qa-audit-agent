const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { createGuard } = require('./frontend');
const { conforms } = require('./shape');
const { pathOf } = require('./generate');
const { grade } = require('./checks');
const browser = require('./browser');

const UNVERIFIABLE_STATUS = [401, 403, 429, 999];
const passed = (detail = '') => ({ status: 'passed', detail });
const failed = (detail) => ({ status: 'failed', detail });
const skipped = (detail) => ({ status: 'skipped', detail });
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/$/, '') : p);

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function withPage(ctx, testCase, fn) {
  const page = await ctx.context.newPage();
  try {
    const result = await fn(page);
    if (result.status === 'failed' && ctx.screenshotDir) {
      const file = `${testCase.id.replace(/[^a-z0-9]+/gi, '-')}.png`;
      await page.screenshot({ path: path.join(ctx.screenshotDir, file) }).catch(() => {});
      result.screenshot = `screenshots/${file}`;
    }
    return result;
  } finally {
    await page.close();
  }
}

const open = (ctx, page, url) => page.goto(url, { waitUntil: 'load', timeout: ctx.timeoutMs });

const RUNNERS = {
  'page-loads': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      const errors = [];
      const bad = [];
      page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('response', (r) => r.status() >= 400 && r.request().resourceType() !== 'document' && bad.push(`${r.status()} ${r.url()}`));
      const response = await open(ctx, page, c.url);
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const problems = [];
      if (!response || response.status() >= 400) {
        problems.push(`status ${response?.status()}${c.from ? `, linked from ${pathOf(c.from)}` : ''}`);
      }
      if (!(await page.title()).trim()) problems.push('empty title');
      if (errors.length) problems.push(`${errors.length} console error(s): ${errors.slice(0, 2).join(' | ')}`);
      if (bad.length) problems.push(`resources failed: ${bad.slice(0, 3).join('; ')}`);
      return problems.length ? failed(problems.join('; ')) : passed();
    }),

  'page-structure': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      await open(ctx, page, c.url);
      const facts = await page.evaluate(browser.structureFacts);
      const problems = [];
      if (facts.h1 !== 1) problems.push(`${facts.h1} h1 headings (expected 1)`);
      if (!facts.lang) problems.push('missing lang attribute');
      if (!facts.viewport) problems.push('missing viewport meta tag');
      return problems.length ? failed(problems.join('; ')) : passed();
    }),

  'page-a11y': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      await open(ctx, page, c.url);
      const { violations } = await new AxeBuilder({ page }).analyze();
      const serious = violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      return serious.length
        ? failed(serious.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} element${v.nodes.length > 1 ? 's' : ''})`).join('; '))
        : passed();
    }),

  'link-ok': async (ctx, c) => {
    try {
      const { status } = await ctx.guard.check(c.url);
      if (status < 400) return passed(`status ${status}`);
      if (UNVERIFIABLE_STATUS.includes(status)) return skipped(`cannot be verified automatically (status ${status})`);
      return failed(`status ${status}, linked from ${pathOf(c.from)}`);
    } catch (error) {
      if (error.message.startsWith('Blocked address')) return skipped(error.message);
      return failed(`unreachable: ${error.message.split('\n')[0]}`);
    }
  },

  'nav-click': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      await open(ctx, page, c.url);
      await page.locator(`a[href=${JSON.stringify(c.raw)}]`).first().click({ timeout: 5000 });
      const expected = trimSlash(c.expectedPath);
      try {
        await page.waitForURL((url) => trimSlash(url.pathname + url.search) === expected, { timeout: 5000 });
      } catch {
        const now = new URL(page.url());
        return failed(`ended on ${now.pathname + now.search}, expected ${c.expectedPath}`);
      }
      return passed();
    }),

  'form-required': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      await open(ctx, page, c.url);
      const form = page.locator('form').nth(c.formIndex);
      const blocked = await form.evaluate(browser.formIsInvalid);
      const notEnforced = [];
      for (const field of c.fields) {
        const missing = await form.locator(field.selector).first().evaluate(browser.valueMissing);
        if (!missing) notEnforced.push(field.label);
      }
      if (!blocked) return failed('the empty form is considered valid');
      return notEnforced.length ? failed(`required not enforced for: ${notEnforced.join(', ')}`) : passed();
    }),

  'form-validation': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      await open(ctx, page, c.url);
      const field = page.locator('form').nth(c.formIndex).locator(c.selector).first();
      await field.fill(c.bad);
      if (!(await field.evaluate(browser.fieldFlag, c.flag))) {
        return failed(`"${c.bad}" was accepted (${c.flag} is false)`);
      }
      await field.fill(c.good);
      if (!(await field.evaluate(browser.fieldIsValid))) return failed(`the valid value "${c.good}" was rejected`);
      return passed();
    }),

  'form-accepts-valid': (ctx, c) =>
    withPage(ctx, c, async (page) => {
      await open(ctx, page, c.url);
      const form = page.locator('form').nth(c.formIndex);
      for (const { selector, tag, type, value } of c.values) {
        const field = form.locator(selector).first();
        if (type === 'checkbox' || type === 'radio') await field.check();
        else if (tag === 'select') await field.selectOption(value);
        else await field.fill(value);
      }
      const invalid = await form.evaluate(browser.invalidFieldNames);
      return invalid.length ? failed(`still invalid: ${invalid.join(', ')}`) : passed();
    }),

  'api-contract': async (ctx, c) => {
    const started = Date.now();
    try {
      const { status, response } = await ctx.guard.check(c.url);
      const durationMs = Date.now() - started;
      if (status >= 400) return failed(`status ${status}`);
      let body;
      try {
        body = await response.json();
      } catch {
        return failed('the response is not JSON');
      }
      const errors = conforms(c.shape, body);
      if (errors.length) return failed(`${c.fromBaseline ? 'differs from the baseline' : 'shape changed'}: ${errors.slice(0, 3).join('; ')}`);
      if (durationMs > ctx.slowApiMs) return failed(`slow response: ${durationMs} ms`);
      return passed(`${durationMs} ms`);
    } catch (error) {
      return failed(error.message.split('\n')[0]);
    }
  },

  'baseline-page': async (ctx, c) => {
    const current = ctx.model.pages.find((p) => pathOf(p.url) === c.key);
    if (!current || current.error) return failed('the page was not reachable in this crawl');
    const problems = [];
    if (current.title !== c.expected.title) problems.push(`title changed from "${c.expected.title}" to "${current.title}"`);
    if (JSON.stringify(current.h1s) !== JSON.stringify(c.expected.h1s)) problems.push('main heading changed');
    const links = new Set(
      current.links.flatMap((l) => {
        try {
          const u = new URL(l.href);
          return u.origin === ctx.model.origin ? [u.pathname + u.search] : [];
        } catch {
          return [];
        }
      }),
    );
    const missingLinks = c.expected.links.filter((l) => !links.has(l));
    if (missingLinks.length) problems.push(`links removed: ${missingLinks.slice(0, 3).join(', ')}`);
    const names = new Set(current.forms.flatMap((f) => f.fields.map((x) => x.name || x.selector)));
    const missingFields = c.expected.forms.flat().filter((n) => !names.has(n));
    if (missingFields.length) problems.push(`form fields removed: ${missingFields.slice(0, 3).join(', ')}`);
    return problems.length ? failed(problems.join('; ')) : passed();
  },
};

const SEVERITY = { 'page-loads': 'high', 'api-contract': 'high', 'page-a11y': 'medium', 'nav-click': 'medium', 'baseline-page': 'medium', 'page-structure': 'low' };
const severityOf = (test) =>
  test.type === 'link-ok' ? (test.external ? 'low' : 'high') : test.type.startsWith('form-') ? 'medium' : SEVERITY[test.type] || 'medium';

async function runSuite({
  model,
  cases,
  allowLocal = false,
  lookup,
  launch = () => chromium.launch(),
  contextOptions = {},
  concurrency = 4,
  timeoutMs = 20000,
  slowApiMs = 3000,
  outDir,
}) {
  const screenshotDir = outDir && path.join(outDir, 'screenshots');
  if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });

  const browser = await launch();
  let tests;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', ...contextOptions });
    const guard = createGuard(context, { allowLocal, lookup });
    await guard.install();
    const ctx = { context, guard, model, timeoutMs, slowApiMs, screenshotDir };

    tests = await pool(cases, concurrency, async (c) => {
      const started = Date.now();
      let result;
      try {
        result = await RUNNERS[c.type](ctx, c);
      } catch (error) {
        result = failed(error.message.split('\n')[0]);
      }
      const { id, group, type, name, url, external } = c;
      return { id, group, type, name, url: url || null, external: Boolean(external), durationMs: Date.now() - started, ...result };
    });
  } finally {
    await browser.close();
  }

  const count = (status) => tests.filter((t) => t.status === status).length;
  const summary = { total: tests.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped') };
  const decided = summary.passed + summary.failed;
  const score = decided ? Math.round((summary.passed / decided) * 100) : 0;
  const failures = tests.filter((t) => t.status === 'failed');

  return {
    kind: 'suite',
    target: model.startUrl,
    specTitle: model.pages[0]?.title || new URL(model.startUrl).host,
    scannedAt: new Date().toISOString(),
    site: {
      pages: model.pages.length,
      forms: model.pages.reduce((n, p) => n + p.forms.length, 0),
      links: new Set(model.pages.flatMap((p) => p.links.map((l) => l.href))).size,
      apiCalls: new Set(model.pages.flatMap((p) => p.apiCalls.map((a) => a.url))).size,
      skipped: model.skipped.length,
      authRequired: model.authRequired,
    },
    tests,
    summary,
    score,
    grade: grade(score),
    endpoints: model.pages.map((p) => ({
      endpoint: `GET ${pathOf(p.url)}`,
      status: p.status,
      durationMs: p.loadMs,
      issues: failures.filter((t) => t.url && pathOf(t.url) === pathOf(p.url)).length,
    })),
    findings: failures.map((t) => ({
      id: t.id,
      severity: severityOf(t),
      endpoint: t.url ? `GET ${pathOf(t.url)}` : 'Site',
      title: t.name,
      detail: t.detail,
    })),
  };
}

module.exports = { runSuite, RUNNERS };
