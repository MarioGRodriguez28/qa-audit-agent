const http = require('node:http');
const net = require('node:net');
const { auditFrontend } = require('../src/frontend');
const { toMarkdown } = require('../src/report');

jest.setTimeout(90000);

const GOOD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Good page</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A well built page"></head>
<body><main><h1>Hello</h1><img src="/ok.png" alt="A pixel"><a href="/ok">fine link</a></main></body></html>`;

const BAD = `<!doctype html><html><head></head><body>
<img src="/missing.png"><button></button><a href="/gone">gone</a>
<script>console.error('boom'); fetch('/api-fail');</script></body></html>`;

const PIXEL = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

let server;
let proxy;
let base;
const seen = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.headers.host.split(':')[0]}${req.url}`);
    const redirect = (to) => res.writeHead(302, { location: to }).end();
    const routes = {
      '/good': () => res.writeHead(200, { 'content-type': 'text/html' }).end(GOOD),
      '/bad': () => res.writeHead(200, { 'content-type': 'text/html' }).end(BAD),
      '/ok': () => res.writeHead(200, { 'content-type': 'text/html' }).end('ok'),
      '/ok.png': () => res.writeHead(200, { 'content-type': 'image/gif' }).end(PIXEL),
      '/api-fail': () => res.writeHead(500).end('nope'),
      '/old': () => redirect('/good'),
      '/redir-main': () => redirect('http://internal.test/secret'),
      '/hop1': () => redirect('http://public.test/hop2'),
      '/hop2': () => redirect('http://internal.test/secret.png'),
      '/img-redir': () => redirect('http://internal.test/secret.png'),
      '/leaky-redirect': () =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>x</h1><img alt="a" src="http://public.test/img-redir"><img alt="b" src="http://public.test/hop1"></main></body></html>'),
      '/leaky': () =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>x</h1><img alt="a" src="http://internal.test/secret.png"></main></body></html>'),
    };
    (routes[req.url] || (() => res.writeHead(404).end()))();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    const upstream = net.connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

const lookup = async (host) => [{ address: host === 'internal.test' ? '10.0.0.5' : '93.184.216.34' }];
const viaProxy = () => ({ lookup, contextOptions: { proxy: { server: `http://127.0.0.1:${proxy.address().port}` } } });

const ids = (result) => result.findings.map((f) => f.id);

describe('auditFrontend', () => {
  it('finds nothing wrong on a clean page', async () => {
    const result = await auditFrontend({ url: `${base}/good`, allowLocal: true });

    expect(result.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(result.score).toBe(100);
    expect(result.kind).toBe('frontend');
    expect(result.endpoints.map((e) => e.status)).toEqual([200, 200]);
  });

  it('reports console errors, bad resources, broken links and accessibility problems', async () => {
    const result = await auditFrontend({ url: `${base}/bad`, allowLocal: true });

    expect(ids(result)).toEqual(
      expect.arrayContaining([
        'CONSOLE_ERROR',
        'BAD_RESOURCE',
        'BROKEN_LINK',
        'MISSING_DESCRIPTION',
        'MISSING_H1',
        'A11Y_image-alt',
        'A11Y_button-name',
      ]),
    );
    expect(result.score).toBeLessThan(40);
    expect(toMarkdown(result, 'x')).toContain('# Frontend audit');
  });

  it('flags a page that returns an error status', async () => {
    const result = await auditFrontend({ url: `${base}/nothing-here`, allowLocal: true });

    expect(ids(result)).toContain('PAGE_ERROR');
  });

  it('refuses a private target without launching a browser', async () => {
    const launch = jest.fn();

    await expect(auditFrontend({ url: 'http://127.0.0.1:9', launch })).rejects.toThrow(/local|private/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it('blocks requests the page makes to private addresses', async () => {
    const result = await auditFrontend({ url: 'http://public.test/leaky', ...viaProxy() });
    const blocked = result.findings.find((f) => f.id === 'BLOCKED_REQUEST');

    expect(blocked.detail).toContain('internal.test');
    expect(blocked.severity).toBe('info');
    expect(ids(result)).not.toContain('REQUEST_FAILED');
  });

  describe('redirects', () => {
    const reachedInternal = () => seen.some((entry) => entry.startsWith('internal.test'));

    beforeEach(() => {
      seen.length = 0;
    });

    it('follows a legitimate redirect', async () => {
      const result = await auditFrontend({ url: `${base}/old`, allowLocal: true });

      expect(result.score).toBe(100);
      expect(result.specTitle).toBe('Good page');
    });

    it('refuses a main page that redirects to a private address', async () => {
      await expect(auditFrontend({ url: 'http://public.test/redir-main', ...viaProxy() })).rejects.toThrow(/blocked address/);
      expect(reachedInternal()).toBe(false);
    });

    it('never reaches a private address through sub-resource redirects, including chains', async () => {
      const result = await auditFrontend({ url: 'http://public.test/leaky-redirect', ...viaProxy() });

      expect(reachedInternal()).toBe(false);
      expect(result.findings.find((f) => f.id === 'BLOCKED_REQUEST').detail).toContain('internal.test');
    });
  });
});
