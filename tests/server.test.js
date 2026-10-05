const http = require('node:http');
const { createApp } = require('../src/server');

const RESULT = {
  kind: 'api',
  target: 'https://api.example.com',
  specTitle: 'Pets API',
  scannedAt: '2026-10-05T00:00:00.000Z',
  endpoints: [{ endpoint: 'GET /pets', status: 200, durationMs: 10, issues: 0 }],
  findings: [],
  score: 100,
  grade: 'A',
};

async function start(options = {}) {
  const runAudit = options.runAudit || jest.fn(async () => RESULT);
  const summarizeFn = options.summarizeFn || jest.fn(async () => ({ text: 'All good.', source: 'template' }));
  const server = createApp({ runAudit, summarizeFn, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, runAudit, summarizeFn, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (base, body, headers = { 'content-type': 'application/json' }) =>
  fetch(`${base}/api/audit`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

function rawRequest(base, { path = '/', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

let ctx;
afterEach(async () => ctx && (await ctx.close()));

describe('static files and headers', () => {
  it('serves the page with a strict content security policy', async () => {
    ctx = await start();
    const res = await fetch(ctx.base);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>QA Audit Agent</title>');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it.each(['/app.js', '/style.css', '/favicon.svg', '/fonts/jetbrainsmono.woff2'])('serves %s', async (file) => {
    ctx = await start();

    expect((await fetch(ctx.base + file)).status).toBe(200);
  });

  it.each(['/../package.json', '/%2e%2e/package.json', '/src/server.js', '/index.html', '/fonts/', '/fonts/other.woff2'])(
    'does not serve %s',
    async (path) => {
      ctx = await start();
      const res = await rawRequest(ctx.base, { path });

      expect(res.status).toBe(404);
      expect(res.body).not.toContain('"name"');
    },
  );

  it('reports whether the AI summary is available, without exposing the key', async () => {
    ctx = await start({ apiKey: 'secret-key' });
    const text = await (await fetch(`${ctx.base}/api/config`)).text();

    expect(JSON.parse(text)).toEqual({ ai: true, allowLocal: false });
    expect(text).not.toContain('secret-key');
  });
});

describe('request protection', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    ctx = await start();
    const res = await rawRequest(ctx.base, { path: '/api/config', headers: { host: 'evil.example.com' } });

    expect(res.status).toBe(403);
  });

  it('accepts an extra allowed host when configured', async () => {
    ctx = await start({ extraHosts: ['audit.example.com'] });
    const res = await rawRequest(ctx.base, { path: '/api/config', headers: { host: 'audit.example.com' } });

    expect(res.status).toBe(200);
  });

  it('requires a JSON content type, which blocks simple cross-site form posts', async () => {
    ctx = await start();
    const res = await post(ctx.base, '{"type":"api"}', { 'content-type': 'text/plain' });

    expect(res.status).toBe(415);
    expect(ctx.runAudit).not.toHaveBeenCalled();
  });

  it('rejects oversized and malformed bodies', async () => {
    ctx = await start();

    expect((await post(ctx.base, JSON.stringify({ target: 'x'.repeat(20_000) }))).status).toBe(413);
    expect((await post(ctx.base, '{not json')).status).toBe(400);
  });

  it('only allows the documented methods', async () => {
    ctx = await start();

    expect((await fetch(`${ctx.base}/api/audit`)).status).toBe(405);
    expect((await fetch(`${ctx.base}/`, { method: 'POST' })).status).toBe(405);
  });
});

describe('input validation', () => {
  it.each([
    [{ type: 'ftp', target: 'https://a.com' }, 'type'],
    [{ type: 'api' }, 'target'],
    [{ type: 'api', target: '/etc/passwd' }, 'valid URL'],
    [{ type: 'api', target: 'file:///etc/passwd' }, 'http'],
    [{ type: 'web', target: 'javascript:alert(1)' }, 'http'],
    [{ type: 'api', target: 'https://a.com/' + 'x'.repeat(3000) }, 'target'],
    [{ type: 'api', target: 'https://a.com', baseUrl: 'gopher://x' }, 'baseUrl'],
    ['"just a string"', 'object'],
  ])('rejects %j', async (body, message) => {
    ctx = await start();
    const res = await post(ctx.base, body);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(ctx.runAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/audit', () => {
  it('runs the audit and returns result, summary and markdown', async () => {
    ctx = await start();
    const res = await post(ctx.base, { type: 'api', target: 'https://api.example.com/openapi.json' });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.result.score).toBe(100);
    expect(data.summary.text).toBe('All good.');
    expect(data.markdown).toContain('# API audit: Pets API');
    expect(ctx.runAudit).toHaveBeenCalledWith(
      { type: 'api', target: 'https://api.example.com/openapi.json', baseUrl: undefined, ai: true },
      { allowLocal: false },
    );
  });

  it('never lets the request turn the local-address guard off', async () => {
    ctx = await start();
    await post(ctx.base, { type: 'web', target: 'https://example.com', allowLocal: true });

    expect(ctx.runAudit.mock.calls[0][1]).toEqual({ allowLocal: false });
  });

  it('only passes the model key when the user wants the AI summary', async () => {
    ctx = await start({ apiKey: 'k' });
    await post(ctx.base, { type: 'web', target: 'https://example.com', ai: false });
    await post(ctx.base, { type: 'web', target: 'https://example.com' });

    expect(ctx.summarizeFn.mock.calls[0][1].apiKey).toBeUndefined();
    expect(ctx.summarizeFn.mock.calls[1][1].apiKey).toBe('k');
  });

  it('returns audit refusals as a readable error', async () => {
    ctx = await start({ runAudit: async () => Promise.reject(new Error('Refusing to audit localhost')) });
    const res = await post(ctx.base, { type: 'web', target: 'https://example.com' });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('Refusing');
  });

  it('times out slow audits', async () => {
    ctx = await start({ runAudit: () => new Promise(() => {}), timeoutMs: 50 });
    const res = await post(ctx.base, { type: 'web', target: 'https://example.com' });

    expect(res.status).toBe(504);
  });

  it('rate limits per client and recovers after the window', async () => {
    let clock = 0;
    ctx = await start({ rateLimit: { max: 2, windowMs: 1000 }, now: () => clock });
    const body = { type: 'api', target: 'https://api.example.com/openapi.json' };

    expect((await post(ctx.base, body)).status).toBe(200);
    expect((await post(ctx.base, body)).status).toBe(200);
    expect((await post(ctx.base, body)).status).toBe(429);
    clock = 1500;
    expect((await post(ctx.base, body)).status).toBe(200);
  });

  it('refuses extra work while the concurrency limit is reached', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    ctx = await start({ runAudit: async () => (await gate, RESULT), maxConcurrent: 1 });
    const body = { type: 'api', target: 'https://api.example.com/openapi.json' };

    const first = post(ctx.base, body);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await post(ctx.base, body);
    release();

    expect(second.status).toBe(503);
    expect((await first).status).toBe(200);
  });
});
