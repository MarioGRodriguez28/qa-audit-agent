const { loadSpec, resolveBaseUrl, listGetOperations, buildRequestPath } = require('./openapi');
const { assertPublicUrl } = require('./safety');
const { checkResponse, checkSecurityHeaders, score, grade, finding } = require('./checks');

async function auditApi({
  source,
  baseUrl,
  fetchImpl = fetch,
  lookup,
  allowLocal = false,
  timeoutMs = 8000,
  slowMs = 1000,
  maxOperations = 30,
}) {
  const spec = await loadSpec(source, fetchImpl);
  const base = resolveBaseUrl(spec, source, baseUrl);
  const { protocol } = await assertPublicUrl(base, { allowLocal, lookup });

  const operations = listGetOperations(spec).slice(0, maxOperations);
  const findings = [];
  const endpoints = [];
  let headersChecked = false;

  for (const op of operations) {
    const requestPath = buildRequestPath(spec, op);
    const started = Date.now();
    try {
      const res = await fetchImpl(`${base}${requestPath}`, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await res.text();
      const durationMs = Date.now() - started;

      if (!headersChecked) {
        findings.push(...checkSecurityHeaders(res.headers, protocol === 'https:'));
        headersChecked = true;
      }
      const opFindings = checkResponse({
        spec,
        op,
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyText,
        durationMs,
        slowMs,
      });
      findings.push(...opFindings);
      endpoints.push({ endpoint: `GET ${op.path}`, status: res.status, durationMs, issues: opFindings.length });
    } catch (error) {
      const durationMs = Date.now() - started;
      findings.push(finding('REQUEST_FAILED', 'high', 'Request failed', `GET ${op.path}`, error.message));
      endpoints.push({ endpoint: `GET ${op.path}`, status: null, durationMs, issues: 1 });
    }
  }

  const value = score(findings);
  return {
    kind: 'api',
    target: base,
    specTitle: spec.info?.title || 'Untitled API',
    scannedAt: new Date().toISOString(),
    endpoints,
    findings,
    score: value,
    grade: grade(value),
  };
}

module.exports = { auditApi };
