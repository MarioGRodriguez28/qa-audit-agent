const { auditApi } = require('../src/audit');
const { spec, jsonResponse, secureHeaders } = require('./fixtures');

const publicLookup = async () => [{ address: '93.184.216.34' }];

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url === 'https://spec.example.com/openapi.json') return jsonResponse(spec);
    const handler = routes[new URL(url).pathname.replace('/v1', '')];
    if (!handler) throw new Error(`unexpected request ${url}`);
    return handler();
  };
  impl.calls = calls;
  return impl;
}

const run = (fetchImpl, extra = {}) =>
  auditApi({ source: 'https://spec.example.com/openapi.json', fetchImpl, lookup: publicLookup, ...extra });

describe('auditApi', () => {
  it('gives a perfect score to a healthy API and only probes GET operations', async () => {
    const fetchImpl = fakeFetch({
      '/pets': () => jsonResponse([{ id: 1, name: 'Rex' }], { headers: secureHeaders }),
      '/pets/1': () => jsonResponse({ id: 1, name: 'Rex' }, { headers: secureHeaders }),
    });

    const result = await run(fetchImpl);

    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.endpoints).toHaveLength(2);
    expect(fetchImpl.calls.some((u) => u.includes('/health'))).toBe(false);
  });

  it('reports server errors, schema mismatches and missing headers', async () => {
    const fetchImpl = fakeFetch({
      '/pets': () => jsonResponse([{ id: 'one' }]),
      '/pets/1': () => jsonResponse({ error: 'boom' }, { status: 500 }),
    });

    const result = await run(fetchImpl);
    const ids = result.findings.map((f) => f.id);

    expect(ids).toEqual(expect.arrayContaining(['SCHEMA_MISMATCH', 'STATUS_5XX', 'HDR_NOSNIFF', 'HDR_HSTS']));
    expect(result.score).toBeLessThan(80);
  });

  it('accepts a documented 404', async () => {
    const fetchImpl = fakeFetch({
      '/pets': () => jsonResponse([], { headers: secureHeaders }),
      '/pets/1': () => jsonResponse({}, { status: 404, headers: secureHeaders }),
    });

    const result = await run(fetchImpl);

    expect(result.findings).toHaveLength(0);
  });

  it('flags undocumented statuses, slow responses and bad content types', async () => {
    const fetchImpl = fakeFetch({
      '/pets': () => new Response('<html></html>', { headers: { 'content-type': 'text/html', ...secureHeaders } }),
      '/pets/1': () => jsonResponse({}, { status: 418, headers: secureHeaders }),
    });

    const result = await run(fetchImpl, { slowMs: -1 });
    const ids = result.findings.map((f) => f.id);

    expect(ids).toEqual(expect.arrayContaining(['CONTENT_TYPE', 'STATUS_UNDOCUMENTED', 'SLOW_RESPONSE']));
  });

  it('flags invalid JSON bodies', async () => {
    const fetchImpl = fakeFetch({
      '/pets': () => jsonResponse('{not json', { headers: secureHeaders }),
      '/pets/1': () => jsonResponse({ id: 1, name: 'x' }, { headers: secureHeaders }),
    });

    const result = await run(fetchImpl);

    expect(result.findings.map((f) => f.id)).toContain('INVALID_JSON');
  });

  it('records a failed request instead of crashing', async () => {
    const fetchImpl = fakeFetch({
      '/pets': () => {
        throw new Error('connect ECONNREFUSED');
      },
      '/pets/1': () => jsonResponse({ id: 1, name: 'x' }, { headers: secureHeaders }),
    });

    const result = await run(fetchImpl);

    expect(result.findings.find((f) => f.id === 'REQUEST_FAILED').detail).toContain('ECONNREFUSED');
  });

  it('refuses private targets before sending any request', async () => {
    const fetchImpl = fakeFetch({});

    await expect(
      auditApi({
        source: 'https://spec.example.com/openapi.json',
        baseUrl: 'http://127.0.0.1:8080',
        fetchImpl,
      }),
    ).rejects.toThrow(/private|local/i);
    expect(fetchImpl.calls).toEqual(['https://spec.example.com/openapi.json']);
  });
});
