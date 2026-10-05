const { chromium } = require('playwright');
const { assertPublicUrl } = require('./safety');
const { createGuard } = require('./frontend');
const { shapeOf } = require('./shape');

const SKIP_PATH = /(log-?out|sign-?out|delete|remove|unsubscribe|destroy)/i;
const FILE_EXTENSION = /\.(pdf|zip|gz|png|jpe?g|gif|svg|webp|ico|css|js|json|xml|txt|mp4|mp3|docx?|xlsx?|pptx?|csv)$/i;
const LOGIN_PATH = /(login|log-in|signin|sign-in|sso|auth|account\/login)/i;
const MAX_API_BODY = 200_000;

/* istanbul ignore next: serialised and executed inside the browser */
function extractFacts() {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const selectorFor = (el) =>
    el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${el.name.replace(/"/g, '\\"')}"]` : null;
  const labelFor = (el) =>
    (el.labels && el.labels[0] ? text(el.labels[0]) : el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');

  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.href,
    raw: a.getAttribute('href'),
    text: text(a),
    nav: Boolean(a.closest('nav, header, [role="navigation"]')),
    visible: visible(a),
    newTab: a.target === '_blank',
    download: a.hasAttribute('download'),
  }));

  const skipTypes = ['hidden', 'submit', 'button', 'reset', 'image'];
  const forms = [...document.forms].map((form, index) => ({
    index,
    id: form.id,
    action: form.action,
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: [...form.elements]
      .filter((el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !skipTypes.includes(el.type) && visible(el))
      .map((el) => ({
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        type: el.type,
        name: el.name,
        label: labelFor(el),
        required: el.required,
        minLength: el.minLength > 0 ? el.minLength : null,
        maxLength: el.maxLength >= 0 ? el.maxLength : null,
        min: el.min || null,
        max: el.max || null,
        pattern: el.pattern || null,
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value).filter(Boolean).slice(0, 5) : [],
      }))
      .filter((f) => f.selector),
  }));

  return {
    title: document.title,
    lang: document.documentElement.lang,
    description: document.querySelector('meta[name="description"]')?.content || '',
    viewport: Boolean(document.querySelector('meta[name="viewport"]')),
    h1s: [...document.querySelectorAll('h1')].map(text),
    links,
    forms: forms.filter((f) => f.fields.length),
  };
}

const normalize = (rawUrl) => {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.href;
};

function crawlable(link, origin) {
  let url;
  try {
    url = new URL(link.href);
  } catch {
    return { ok: false, reason: 'invalid url' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'not http' };
  if (url.origin !== origin) return { ok: false, reason: 'other origin' };
  if (link.download || FILE_EXTENSION.test(url.pathname)) return { ok: false, reason: 'file' };
  if (SKIP_PATH.test(url.pathname)) return { ok: false, reason: 'destructive or sign-out path' };
  return { ok: true, url: normalize(url.href) };
}

async function visit(context, guard, url, origin, timeoutMs) {
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const pending = [];
  const apiCalls = [];

  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('requestfailed', (r) => {
    let host = '';
    try {
      host = new URL(r.url()).host;
    } catch {
      /* ignore */
    }
    if (!guard.blockedHosts.has(host)) failedRequests.push(`${r.failure()?.errorText} ${r.url()}`);
  });
  page.on('response', (r) => {
    const request = r.request();
    const status = r.status();
    if (status >= 400 && request.resourceType() !== 'document') failedRequests.push(`${status} ${r.url()}`);
    if (!['fetch', 'xhr'].includes(request.resourceType())) return;
    if (new URL(r.url()).origin !== origin) return;
    pending.push(
      (async () => {
        const contentType = r.headers()['content-type'] || '';
        let shape = null;
        if (/json/i.test(contentType) && status < 400) {
          try {
            const body = await r.text();
            if (body.length < MAX_API_BODY) shape = shapeOf(JSON.parse(body));
          } catch {
            /* not parseable: keep shape null */
          }
        }
        apiCalls.push({ method: request.method(), url: r.url(), status, contentType, shape });
      })(),
    );
  });

  const started = Date.now();
  let response = null;
  let facts = null;
  let error = null;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    facts = await page.evaluate(extractFacts);
    await Promise.all(pending);
  } catch (e) {
    error = e.message.split('\n')[0];
  }
  const finalUrl = page.url();
  await page.close();

  return {
    url,
    finalUrl,
    status: response?.status() ?? null,
    loadMs: Date.now() - started,
    error,
    consoleErrors,
    failedRequests,
    apiCalls: apiCalls.filter((c) => c.method === 'GET'),
    ...(facts || { title: '', lang: '', description: '', viewport: false, h1s: [], links: [], forms: [] }),
  };
}

async function explore({
  url,
  maxPages = 12,
  depth = 2,
  allowLocal = false,
  lookup,
  timeoutMs = 20000,
  launch = () => chromium.launch(),
  contextOptions = {},
}) {
  const start = await assertPublicUrl(url, { allowLocal, lookup });
  const origin = start.origin;
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', ...contextOptions });
    const guard = createGuard(context, { allowLocal, lookup });
    await guard.install();

    const queue = [{ url: normalize(start.href), depth: 0, from: null }];
    const seen = new Set([queue[0].url]);
    const pages = [];
    const skipped = [];
    let authRequired = false;

    while (queue.length && pages.length < maxPages) {
      const next = queue.shift();
      const page = await visit(context, guard, next.url, origin, timeoutMs);
      page.depth = next.depth;
      page.from = next.from;
      if (!pages.length && (page.error || page.status >= 400)) {
        throw new Error(
          page.error ? `Could not load the start page: ${page.error}` : `The start page returned status ${page.status}`,
        );
      }
      pages.push(page);

      if (page.finalUrl && new URL(page.finalUrl).origin !== origin) {
        skipped.push({ url: next.url, reason: 'redirected to another origin' });
        continue;
      }
      if (page.finalUrl && LOGIN_PATH.test(new URL(page.finalUrl).pathname) && !LOGIN_PATH.test(new URL(next.url).pathname)) {
        authRequired = true;
      }
      if (next.depth >= depth) continue;
      for (const link of page.links) {
        const verdict = crawlable(link, origin);
        if (!verdict.ok) {
          if (verdict.reason !== 'other origin' && verdict.reason !== 'not http') skipped.push({ url: link.href, reason: verdict.reason });
          continue;
        }
        if (!seen.has(verdict.url)) {
          seen.add(verdict.url);
          queue.push({ url: verdict.url, depth: next.depth + 1, from: next.url });
        }
      }
    }
    for (const left of queue) skipped.push({ url: left.url, reason: 'page limit reached' });

    return {
      startUrl: start.href,
      origin,
      crawledAt: new Date().toISOString(),
      authRequired,
      pages,
      skipped: skipped.filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i),
    };
  } finally {
    await browser.close();
  }
}

module.exports = { explore, crawlable, normalize };
