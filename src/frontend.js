const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { assertPublicUrl } = require('./safety');
const { finding, score, grade } = require('./checks');

const AXE_SEVERITY = { critical: 'high', serious: 'medium', moderate: 'low', minor: 'low' };
const LINK_BATCH = 5;

function pageFacts() {
  const abs = (el) => el.src || el.href;
  return {
    title: document.title,
    description: !!document.querySelector('meta[name="description"]')?.content,
    h1Count: document.querySelectorAll('h1').length,
    links: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)),
    mixedContent:
      location.protocol === 'https:'
        ? [...document.querySelectorAll('img[src],script[src],iframe[src],link[rel="stylesheet"][href]')]
            .map(abs)
            .filter((u) => u.startsWith('http:'))
        : [],
  };
}

const MAX_HOPS = 5;
const isRedirect = (response) => [301, 302, 303, 307, 308].includes(response.status());

function createGuard(context, { allowLocal, lookup }) {
  const verdicts = new Map();
  const blockedHosts = new Set();

  async function isAllowed(rawUrl) {
    if (!/^https?:/i.test(rawUrl)) return false;
    const { host } = new URL(rawUrl);
    if (!verdicts.has(host)) {
      verdicts.set(
        host,
        assertPublicUrl(rawUrl, { allowLocal, lookup }).then(
          () => true,
          () => false,
        ),
      );
    }
    const ok = await verdicts.get(host);
    if (!ok) blockedHosts.add(host);
    return ok;
  }

  // The browser follows redirects inside its network stack, where request routing never sees them,
  // so redirects are followed here and every hop is validated before the browser learns about it.
  async function followRedirects(response) {
    for (let hop = 0; isRedirect(response); hop++) {
      const location = response.headers().location;
      if (!location || hop >= MAX_HOPS) return null;
      const next = new URL(location, response.url()).toString();
      if (!(await isAllowed(next))) return null;
      response = await context.request.get(next, { maxRedirects: 0, failOnStatusCode: false });
    }
    return response;
  }

  async function resolveFinalUrl(startUrl, timeoutMs) {
    let current = startUrl;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const response = await context.request.get(current, { maxRedirects: 0, failOnStatusCode: false, timeout: timeoutMs });
      if (!isRedirect(response)) return current;
      const next = new URL(response.headers().location || '', current).toString();
      if (!(await isAllowed(next))) throw new Error(`Redirected to a blocked address: ${new URL(next).host}`);
      current = next;
    }
    throw new Error('Too many redirects');
  }

  async function install() {
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (!/^https?:/i.test(requestUrl)) return route.continue();
      if (!(await isAllowed(requestUrl))) return route.abort('blockedbyclient');
      try {
        const final = await followRedirects(await route.fetch({ maxRedirects: 0 }));
        return final ? route.fulfill({ response: final }) : route.abort('blockedbyclient');
      } catch {
        return route.abort('failed');
      }
    });
  }

  return { install, resolveFinalUrl, blockedHosts };
}

async function checkLinks(context, links, { allowLocal, lookup, timeoutMs }) {
  const rows = [];
  const findings = [];
  for (let i = 0; i < links.length; i += LINK_BATCH) {
    await Promise.all(
      links.slice(i, i + LINK_BATCH).map(async (link) => {
        const endpoint = `GET ${link}`;
        const started = Date.now();
        try {
          await assertPublicUrl(link, { allowLocal, lookup });
          const res = await context.request.get(link, { timeout: timeoutMs, maxRedirects: 0, failOnStatusCode: false });
          const status = res.status();
          const bad = status >= 400;
          rows.push({ endpoint, status, durationMs: Date.now() - started, issues: bad ? 1 : 0 });
          if (bad) findings.push(finding('BROKEN_LINK', 'medium', 'Broken link', endpoint, `Returned ${status}`));
        } catch (error) {
          rows.push({ endpoint, status: null, durationMs: Date.now() - started, issues: 1 });
          findings.push(finding('BROKEN_LINK', 'medium', 'Link could not be checked', endpoint, error.message.split('\n')[0]));
        }
      }),
    );
  }
  return { rows, findings };
}

async function auditFrontend({
  url,
  allowLocal = false,
  lookup,
  maxLinks = 25,
  slowMs = 3000,
  timeoutMs = 20000,
  launch = () => chromium.launch(),
  contextOptions = {},
}) {
  await assertPublicUrl(url, { allowLocal, lookup });
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', ...contextOptions });
    const guard = createGuard(context, { allowLocal, lookup });
    const { blockedHosts } = guard;
    await guard.install();

    const page = await context.newPage();
    const consoleErrors = [];
    const badResources = [];
    const failedRequests = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400 && r.request().resourceType() !== 'document') badResources.push(`${r.status()} ${r.url()}`);
    });
    page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), reason: r.failure()?.errorText }));

    const finalUrl = await guard.resolveFinalUrl(url, timeoutMs);
    const started = Date.now();
    const response = await page.goto(finalUrl, { waitUntil: 'load', timeout: timeoutMs });
    const loadMs = Date.now() - started;
    const status = response?.status() ?? null;

    const findings = [];
    const add = (id, severity, title, detail) => findings.push(finding(id, severity, title, 'Page', detail));

    if (status >= 400) add('PAGE_ERROR', 'high', 'Page returned an error', `Status ${status}`);
    if (loadMs > slowMs) add('SLOW_PAGE', 'medium', 'Slow page load', `${loadMs} ms (limit ${slowMs} ms)`);
    if (consoleErrors.length) {
      add('CONSOLE_ERROR', 'medium', 'JavaScript errors in the console', `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
    if (badResources.length) {
      add('BAD_RESOURCE', 'medium', 'Resources failed to load', `${badResources.length}: ${badResources.slice(0, 5).join('; ')}`);
    }
    const networkFailures = failedRequests.filter((r) => !blockedHosts.has(safeHost(r.url)));
    if (networkFailures.length) {
      add('REQUEST_FAILED', 'medium', 'Network requests failed', networkFailures.slice(0, 5).map((r) => `${r.reason} ${r.url}`).join('; '));
    }
    if (blockedHosts.size) {
      add('BLOCKED_REQUEST', 'info', 'Requests to private addresses were blocked', [...blockedHosts].join(', '));
    }

    const facts = await page.evaluate(pageFacts);
    if (!facts.description) add('MISSING_DESCRIPTION', 'low', 'Missing meta description', 'Search engines show this text in results');
    if (facts.h1Count === 0) add('MISSING_H1', 'low', 'No h1 heading', 'Each page should have one main heading');
    if (facts.h1Count > 1) add('MULTIPLE_H1', 'low', 'More than one h1 heading', `Found ${facts.h1Count}`);
    if (facts.mixedContent.length) {
      add('MIXED_CONTENT', 'medium', 'HTTP resources on an HTTPS page', facts.mixedContent.slice(0, 3).join('; '));
    }

    const axe = await new AxeBuilder({ page }).analyze();
    for (const v of axe.violations) {
      add(`A11Y_${v.id}`, AXE_SEVERITY[v.impact] || 'low', `Accessibility: ${v.help}`, `${v.nodes.length} element(s)`);
    }

    const origin = new URL(page.url()).href.split('#')[0];
    const links = [...new Set(facts.links.map((l) => l.split('#')[0]))].filter((l) => l !== origin).slice(0, maxLinks);
    const linkResult = await checkLinks(context, links, { allowLocal, lookup, timeoutMs: 10000 });
    findings.push(...linkResult.findings);

    const value = score(findings);
    return {
      kind: 'frontend',
      target: url,
      specTitle: facts.title || new URL(url).host,
      scannedAt: new Date().toISOString(),
      endpoints: [{ endpoint: `GET ${url}`, status, durationMs: loadMs, issues: findings.length - linkResult.findings.length }, ...linkResult.rows],
      findings,
      score: value,
      grade: grade(value),
    };
  } finally {
    await browser.close();
  }
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}

module.exports = { auditFrontend };
