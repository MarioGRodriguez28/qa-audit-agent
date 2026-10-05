const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assertPublicUrl, isPrivateIP } = require('../src/safety');
const { validate } = require('../src/schema');
const { loadSpec, resolveBaseUrl, listGetOperations, buildRequestPath } = require('../src/openapi');
const { summarize, buildPrompt } = require('../src/llm');
const { toMarkdown, toJson } = require('../src/report');
const { score, grade } = require('../src/checks');
const { spec, jsonResponse } = require('./fixtures');

describe('safety', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'])(
    'treats %s as private',
    (ip) => expect(isPrivateIP(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::1111'])('treats %s as public', (ip) =>
    expect(isPrivateIP(ip)).toBe(false),
  );

  it('rejects localhost, non-http and private DNS results', async () => {
    await expect(assertPublicUrl('http://localhost:3000')).rejects.toThrow();
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow('protocol');
    await expect(
      assertPublicUrl('https://sneaky.example.com', { lookup: async () => [{ address: '10.0.0.5' }] }),
    ).rejects.toThrow('private');
  });

  it('allows local addresses only when asked', async () => {
    await expect(assertPublicUrl('http://localhost:3000', { allowLocal: true })).resolves.toBeInstanceOf(URL);
  });
});

describe('schema validator', () => {
  const pet = spec.components.schemas.Pet;

  it('accepts valid data, including nullable fields', () => {
    expect(validate(spec, pet, { id: 1, name: 'a', tag: null })).toEqual([]);
  });

  it('reports wrong types and missing required fields', () => {
    const errors = validate(spec, pet, { id: 'x' });

    expect(errors).toEqual(
      expect.arrayContaining(['$.id: expected integer, got string', '$.name: required property is missing']),
    );
  });

  it('validates arrays, enums, oneOf and allOf', () => {
    expect(validate(spec, { type: 'array', items: pet }, [{ id: 1, name: 'a' }, { id: 2 }])).toHaveLength(1);
    expect(validate(spec, { enum: ['a'] }, 'b')).toHaveLength(1);
    expect(validate(spec, { oneOf: [{ type: 'string' }, { type: 'integer' }] }, 5)).toEqual([]);
    expect(validate(spec, { oneOf: [{ type: 'string' }, { type: 'integer' }] }, true)).not.toEqual([]);
    expect(validate(spec, { allOf: [pet, { type: 'object', required: ['tag'] }] }, { id: 1, name: 'a' })).toHaveLength(1);
  });
});

describe('spec helpers', () => {
  it('lists GET operations and builds request paths', () => {
    const ops = listGetOperations(spec);

    expect(ops.map((o) => o.path)).toEqual(['/pets', '/pets/{petId}']);
    expect(buildRequestPath(spec, ops[1])).toBe('/pets/1');
  });

  it('adds required query parameters', () => {
    const op = {
      path: '/search',
      params: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', enum: ['cat'] } }],
    };

    expect(buildRequestPath(spec, op)).toBe('/search?q=cat');
  });

  it('resolves relative server urls against the spec url', () => {
    const relative = { servers: [{ url: '/api/v3' }] };

    expect(resolveBaseUrl(relative, 'https://host.example.com/openapi.json')).toBe('https://host.example.com/api/v3');
    expect(resolveBaseUrl(spec, 'file.json', 'https://override.test/')).toBe('https://override.test');
    expect(() => resolveBaseUrl({}, 'file.json')).toThrow('servers');
  });

  it('loads a spec from disk and from a url', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'spec-')), 'openapi.json');
    await fs.writeFile(file, JSON.stringify(spec));

    expect((await loadSpec(file)).info.title).toBe('Pets API');
    expect((await loadSpec('https://x.test/spec.json', async () => jsonResponse(spec))).info.title).toBe('Pets API');
    await expect(loadSpec('https://x.test/spec.json', async () => jsonResponse({}, { status: 404 }))).rejects.toThrow('404');
  });
});

describe('spec loading errors', () => {
  const html = '<!doctype html><html><body>Swagger UI</body></html>';

  it('explains when the URL returns an HTML page', async () => {
    await expect(loadSpec('https://api.example.com/docs?token=secret', async () => jsonResponse(html))).rejects.toThrow(
      /api\.example\.com\/docs returned an HTML page.*\/openapi\.json/,
    );
  });

  it('does not echo the query string of the url', async () => {
    await expect(loadSpec('https://api.example.com/docs?token=secret', async () => jsonResponse(html))).rejects.not.toThrow(/secret/);
  });

  it('explains YAML specs, invalid JSON and JSON that is not an OpenAPI spec', async () => {
    const load = (body) => loadSpec('https://api.example.com/spec', async () => jsonResponse(body));

    await expect(load('openapi: 3.0.0\ninfo:\n  title: x')).rejects.toThrow('YAML');
    await expect(load('{broken')).rejects.toThrow('not valid JSON');
    await expect(load({ hello: 'world' })).rejects.toThrow('no "paths"');
  });
});

describe('scoring', () => {
  it('penalises by severity and maps to grades', () => {
    expect(score([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }])).toBe(76);
    expect(score(Array(10).fill({ severity: 'high' }))).toBe(0);
    expect([95, 80, 65, 45, 10].map(grade)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });
});

describe('llm summary', () => {
  const result = {
    specTitle: 'Pets API',
    score: 80,
    grade: 'B',
    endpoints: [{}],
    findings: [{ severity: 'high', endpoint: 'GET /pets', title: 'Server error', detail: '500' }],
  };

  it('falls back to a template without an api key', async () => {
    expect(await summarize(result)).toMatchObject({ source: 'template' });
  });

  it('uses the model answer when available and sends the key in a header', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'All good.' }] } }] }));

    const out = await summarize(result, { apiKey: 'k', model: 'm', fetchImpl });

    expect(out).toEqual({ text: 'All good.', source: 'llm' });
    expect(fetchImpl.mock.calls[0][0]).toContain('models/m:generateContent');
    expect(fetchImpl.mock.calls[0][1].headers['x-goog-api-key']).toBe('k');
    expect(fetchImpl.mock.calls[0][0]).not.toContain('key=');
  });

  it('falls back with a warning when the model call fails', async () => {
    const out = await summarize(result, { apiKey: 'k', fetchImpl: async () => jsonResponse({}, { status: 429 }) });

    expect(out.source).toBe('template');
    expect(out.warning).toContain('429');
  });

  it('marks audit data as untrusted in the prompt', () => {
    expect(buildPrompt(result)).toContain('untrusted data');
  });
});

describe('report', () => {
  const result = {
    specTitle: 'Pets API',
    target: 'https://api.example.com',
    scannedAt: '2026-10-05T00:00:00.000Z',
    score: 90,
    grade: 'A',
    findings: [
      { severity: 'low', endpoint: 'API', title: 'Low one', detail: 'd' },
      { severity: 'high', endpoint: 'GET /x', title: 'High one', detail: 'd' },
    ],
    endpoints: [{ endpoint: 'GET /x', status: 500, durationMs: 12, issues: 1 }],
  };

  it('lists the most severe findings first', () => {
    const md = toMarkdown(result, 'Summary text');

    expect(md.indexOf('High one')).toBeLessThan(md.indexOf('Low one'));
    expect(md).toContain('90/100');
    expect(md).toContain('| `GET /x` | 500 | 12 ms | 1 |');
  });

  it('says so when there are no findings and serialises to json', () => {
    expect(toMarkdown({ ...result, findings: [] }, 's')).toContain('No issues found.');
    expect(JSON.parse(toJson(result, 's')).summary).toBe('s');
  });
});
