const fs = require('node:fs/promises');
const path = require('node:path');

function describeSource(source) {
  if (!/^https?:\/\//i.test(source)) return path.basename(source);
  const url = new URL(source);
  return `${url.host}${url.pathname}`;
}

function parseSpec(text, source) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    const head = text.trimStart().slice(0, 300).toLowerCase();
    if (head.startsWith('<')) {
      throw new Error(
        `${describeSource(source)} returned an HTML page, not an OpenAPI JSON file. ` +
          'Open the API docs and look for the link to the JSON spec (often /openapi.json, /v3/api-docs or /swagger.json), then use that URL.',
      );
    }
    if (/^(openapi|swagger)\s*:/m.test(head)) {
      throw new Error('The spec is YAML, which is not supported yet. Use the JSON version of the spec.');
    }
    throw new Error(`${describeSource(source)} is not valid JSON.`);
  }
  if (!spec || typeof spec !== 'object' || !spec.paths || typeof spec.paths !== 'object') {
    throw new Error('The JSON does not look like an OpenAPI spec: no "paths" found.');
  }
  return spec;
}

async function loadSpec(source, fetchImpl = fetch) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchImpl(source, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Could not download the spec (${res.status})`);
    return parseSpec(await res.text(), source);
  }
  return parseSpec(await fs.readFile(source, 'utf8'), source);
}

function resolveRef(spec, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref is supported: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
}

function deref(spec, node, depth = 0) {
  if (node && node.$ref && depth < 10) {
    return deref(spec, resolveRef(spec, node.$ref), depth + 1);
  }
  return node;
}

function resolveBaseUrl(spec, source, override) {
  if (override) return override.replace(/\/+$/, '');
  const server = spec.servers?.[0]?.url;
  if (!server) throw new Error('The spec has no servers[]; pass --base-url');
  const origin = /^https?:\/\//i.test(source) ? source : undefined;
  return new URL(server, origin).toString().replace(/\/+$/, '');
}

function sampleValue(spec, param) {
  const schema = deref(spec, param.schema) || {};
  if (param.example !== undefined) return param.example;
  if (schema.example !== undefined) return schema.example;
  if (schema.enum) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  return 'test';
}

function listGetOperations(spec) {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!item.get) continue;
    const params = [...(item.parameters || []), ...(item.get.parameters || [])].map((p) =>
      deref(spec, p),
    );
    operations.push({
      path,
      operationId: item.get.operationId,
      params,
      responses: item.get.responses || {},
    });
  }
  return operations;
}

function buildRequestPath(spec, op) {
  let path = op.path;
  const query = new URLSearchParams();
  for (const param of op.params) {
    const value = sampleValue(spec, param);
    if (param.in === 'path') path = path.replace(`{${param.name}}`, encodeURIComponent(value));
    if (param.in === 'query' && param.required) query.set(param.name, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

module.exports = {
  loadSpec,
  deref,
  resolveBaseUrl,
  listGetOperations,
  buildRequestPath,
};
