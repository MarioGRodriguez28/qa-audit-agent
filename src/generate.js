const { crawlable, normalize } = require('./explore');

const LIMITS = { links: 40, external: 15, nav: 8, forms: 6, api: 10, violationsPerForm: 8 };
const TEXT_TYPES = ['text', 'textarea', 'password', 'search', 'tel', 'url', 'email'];

const pathOf = (rawUrl) => {
  const url = new URL(rawUrl);
  return url.pathname + url.search;
};

const fit = (value, min, max) => {
  let out = value;
  while (min && out.length < min) out += 'x';
  return max !== null && max !== undefined && out.length > max ? out.slice(0, max) : out;
};

function goodValue(field) {
  if (field.tag === 'select') return field.options[0] ?? null;
  const number = (v) => (v === null || v === '' ? null : Number(v));
  switch (field.type) {
    case 'email': return 'qa.tester@example.com';
    case 'url': return 'https://example.com';
    case 'tel': return '+34600123456';
    case 'date': return '2026-01-15';
    case 'time': return '10:30';
    case 'datetime-local': return '2026-01-15T10:30';
    case 'month': return '2026-01';
    case 'week': return '2026-W03';
    case 'color': return '#336699';
    case 'checkbox':
    case 'radio': return true;
    case 'file': return null;
    case 'number':
    case 'range': {
      const min = number(field.min);
      const max = number(field.max);
      if (min !== null && max !== null) return String(Math.round((min + max) / 2));
      if (min !== null) return String(min);
      if (max !== null) return String(max);
      return '5';
    }
    case 'password': return fit('Passw0rd!xyz', field.minLength, field.maxLength);
    default: return fit('Test value', field.minLength, field.maxLength);
  }
}

function violations(field) {
  const found = [];
  const good = goodValue(field);
  if (good === null || good === true) return found;
  if (field.type === 'email') found.push({ flag: 'typeMismatch', bad: 'not-an-email', good, label: 'rejects an invalid email address' });
  if (field.type === 'url') found.push({ flag: 'typeMismatch', bad: 'not a url', good, label: 'rejects an invalid URL' });
  if (['number', 'range'].includes(field.type)) {
    if (field.min !== null && field.min !== '') {
      found.push({ flag: 'rangeUnderflow', bad: String(Number(field.min) - 1), good, label: `rejects a value below ${field.min}` });
    }
    if (field.max !== null && field.max !== '') {
      found.push({ flag: 'rangeOverflow', bad: String(Number(field.max) + 1), good, label: `rejects a value above ${field.max}` });
    }
  }
  if (field.minLength && field.minLength > 1 && TEXT_TYPES.includes(field.type)) {
    found.push({ flag: 'tooShort', bad: 'x'.repeat(field.minLength - 1), good, label: `rejects fewer than ${field.minLength} characters` });
  }
  return found;
}

const fieldName = (field) => field.label || field.name || field.selector;

function generateTests(model, { baseline } = {}) {
  const cases = [];
  const counters = {};
  const add = (group, type, name, data) => {
    counters[group] = (counters[group] || 0) + 1;
    cases.push({ id: `${group}:${counters[group]}`, group, type, name, ...data });
  };

  const crawledUrls = new Set(model.pages.flatMap((p) => [normalize(p.url), p.finalUrl && normalize(p.finalUrl)]).filter(Boolean));

  for (const page of model.pages) {
    const where = pathOf(page.url);
    add('page', 'page-loads', `Page loads without errors: ${where}`, { url: page.url, from: page.from || null });
    if (page.error || page.status >= 400) continue;
    add('page', 'page-structure', `Page structure (one h1, lang, viewport): ${where}`, { url: page.url });
    add('a11y', 'page-a11y', `No serious accessibility violations: ${where}`, { url: page.url });
  }

  const start = model.pages[0];
  const navLinks = [];
  for (const link of start?.links || []) {
    const verdict = crawlable(link, model.origin);
    if (!verdict.ok || !link.nav || !link.visible || link.newTab || link.raw.startsWith('#')) continue;
    if (verdict.url === normalize(start.url) || navLinks.some((n) => n.href === verdict.url)) continue;
    const target = model.pages.find((p) => normalize(p.url) === verdict.url);
    navLinks.push({ href: verdict.url, raw: link.raw, text: link.text, expectedPath: pathOf(target?.finalUrl || verdict.url) });
  }
  for (const nav of navLinks.slice(0, LIMITS.nav)) {
    add('navigation', 'nav-click', `Navigation: "${nav.text || nav.raw}" leads to ${nav.expectedPath}`, { url: start.url, ...nav });
  }

  const checked = new Set();
  const external = [];
  for (const page of model.pages) {
    for (const link of page.links) {
      let url;
      try {
        url = new URL(link.href);
      } catch {
        continue;
      }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const key = normalize(url.href);
      if (checked.has(key) || crawledUrls.has(key) || key === normalize(page.url)) continue;
      const isExternal = url.origin !== model.origin;
      if (!isExternal && !crawlable(link, model.origin).ok && /(log-?out|sign-?out|delete|remove|unsubscribe|destroy)/i.test(url.pathname)) continue;
      checked.add(key);
      if (isExternal) external.push({ url: key, from: page.url });
      else if (checked.size - external.length <= LIMITS.links) {
        add('links', 'link-ok', `Link works: ${pathOf(key)} (from ${pathOf(page.url)})`, { url: key, from: page.url, external: false });
      }
    }
  }
  for (const link of external.slice(0, LIMITS.external)) {
    add('links', 'link-ok', `External link works: ${new URL(link.url).host}${pathOf(link.url)}`, { url: link.url, from: link.from, external: true });
  }

  let formCount = 0;
  for (const page of model.pages) {
    for (const form of page.forms) {
      if (formCount >= LIMITS.forms) break;
      formCount += 1;
      const label = form.id ? `#${form.id}` : pathOf(form.action || page.url);
      const base = { url: page.url, formIndex: form.index };
      const required = form.fields.filter((f) => f.required && f.type !== 'checkbox' && f.type !== 'radio');
      if (required.length) {
        add('forms', 'form-required', `Form ${label} on ${pathOf(page.url)}: an empty form is blocked (${required.map(fieldName).join(', ')})`, {
          ...base,
          fields: required.map((f) => ({ selector: f.selector, label: fieldName(f) })),
        });
      }
      let count = 0;
      for (const field of form.fields) {
        for (const v of violations(field)) {
          if (count++ >= LIMITS.violationsPerForm) break;
          add('forms', 'form-validation', `Form ${label} on ${pathOf(page.url)}: ${fieldName(field)} ${v.label}`, {
            ...base,
            selector: field.selector,
            ...v,
          });
        }
      }
      const fillable = form.fields.map((f) => ({ field: f, value: goodValue(f) }));
      const unfillable = fillable.some(({ field, value }) => value === null || field.pattern || field.type === 'file');
      if (!unfillable && fillable.length) {
        add('forms', 'form-accepts-valid', `Form ${label} on ${pathOf(page.url)}: valid data passes validation (not submitted)`, {
          ...base,
          values: fillable.map(({ field, value }) => ({ selector: field.selector, tag: field.tag, type: field.type, value })),
        });
      }
    }
  }

  const apiSeen = new Set();
  for (const page of model.pages) {
    for (const call of page.apiCalls) {
      if (apiSeen.has(call.url) || apiSeen.size >= LIMITS.api || call.status >= 400 || !call.shape) continue;
      apiSeen.add(call.url);
      const baselineShape = baseline?.api?.[call.url];
      add('api', 'api-contract', `API contract: GET ${pathOf(call.url)} (seen on ${pathOf(page.url)})`, {
        url: call.url,
        status: call.status,
        shape: baselineShape || call.shape,
        fromBaseline: Boolean(baselineShape),
      });
    }
  }

  if (baseline) {
    for (const [key, expected] of Object.entries(baseline.pages)) {
      add('baseline', 'baseline-page', `Baseline: ${key} is unchanged`, { key, expected });
    }
  }
  return cases;
}

function createBaseline(model) {
  const pages = {};
  const api = {};
  for (const page of model.pages) {
    if (page.error) continue;
    const links = new Set();
    for (const link of page.links) {
      try {
        const url = new URL(link.href);
        if (url.origin === model.origin) links.add(pathOf(normalize(link.href)));
      } catch {
        /* ignore */
      }
    }
    pages[pathOf(page.url)] = {
      title: page.title,
      h1s: page.h1s,
      links: [...links].sort(),
      forms: page.forms.map((f) => f.fields.map((x) => x.name || x.selector).sort()),
    };
    for (const call of page.apiCalls) if (call.shape && call.status < 400) api[call.url] = call.shape;
  }
  return { version: 1, createdAt: new Date().toISOString(), startUrl: model.startUrl, pages, api };
}

module.exports = { generateTests, createBaseline, goodValue, violations, pathOf };
