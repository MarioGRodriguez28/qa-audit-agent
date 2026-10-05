const { deref } = require('./openapi');
const { validate } = require('./schema');

const finding = (id, severity, title, endpoint, detail) => ({
  id,
  severity,
  title,
  endpoint,
  detail,
});

function documentedResponse(op, status) {
  return op.responses[String(status)] || op.responses[`${String(status)[0]}XX`] || op.responses.default;
}

function checkResponse({ spec, op, status, contentType, bodyText, durationMs, slowMs }) {
  const endpoint = `GET ${op.path}`;
  const findings = [];
  const documented = documentedResponse(op, status);

  if (status >= 500) {
    findings.push(finding('STATUS_5XX', 'high', 'Server error', endpoint, `Returned ${status}`));
  }
  if (!documented && status < 500) {
    findings.push(
      finding('STATUS_UNDOCUMENTED', 'medium', 'Status code not in the spec', endpoint, `Returned ${status}`),
    );
  }
  if (durationMs > slowMs) {
    findings.push(
      finding('SLOW_RESPONSE', 'medium', 'Slow response', endpoint, `${durationMs} ms (limit ${slowMs} ms)`),
    );
  }

  const content = documented && deref(spec, documented).content;
  const jsonSchema = content?.['application/json']?.schema;
  if (content?.['application/json'] && !/json/i.test(contentType || '')) {
    findings.push(
      finding('CONTENT_TYPE', 'medium', 'Unexpected content type', endpoint, `Got "${contentType || 'none'}", expected JSON`),
    );
    return findings;
  }

  if (jsonSchema && /json/i.test(contentType || '')) {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      findings.push(finding('INVALID_JSON', 'high', 'Response is not valid JSON', endpoint, 'The body could not be parsed'));
      return findings;
    }
    const errors = validate(spec, jsonSchema, body);
    if (errors.length) {
      findings.push(
        finding(
          'SCHEMA_MISMATCH',
          'medium',
          'Response does not match the spec',
          endpoint,
          errors.slice(0, 3).join('; '),
        ),
      );
    }
  }
  return findings;
}

function checkSecurityHeaders(headers, isHttps) {
  const findings = [];
  const api = 'API';
  if (!headers.get('x-content-type-options')) {
    findings.push(
      finding('HDR_NOSNIFF', 'low', 'Missing X-Content-Type-Options', api, 'Add "nosniff" to stop MIME sniffing'),
    );
  }
  if (isHttps && !headers.get('strict-transport-security')) {
    findings.push(
      finding('HDR_HSTS', 'low', 'Missing Strict-Transport-Security', api, 'HTTPS responses should send HSTS'),
    );
  }
  if (headers.get('access-control-allow-origin') === '*') {
    findings.push(
      finding('CORS_WILDCARD', 'low', 'CORS allows any origin', api, 'Access-Control-Allow-Origin is "*"'),
    );
  }
  return findings;
}

const PENALTY = { high: 15, medium: 7, low: 2 };

function score(findings) {
  const total = findings.reduce((sum, f) => sum + (PENALTY[f.severity] || 0), 0);
  return Math.max(0, 100 - total);
}

function grade(value) {
  if (value >= 90) return 'A';
  if (value >= 75) return 'B';
  if (value >= 60) return 'C';
  if (value >= 40) return 'D';
  return 'F';
}

module.exports = { checkResponse, checkSecurityHeaders, score, grade, finding };
