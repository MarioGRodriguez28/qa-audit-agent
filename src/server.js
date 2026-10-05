#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { auditApi } = require('./audit');
const { auditFrontend } = require('./frontend');
const { summarize } = require('./llm');
const { toMarkdown } = require('./report');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 'public, max-age=86400'],
  '/fonts/jetbrainsmono.woff2': ['fonts/jetbrainsmono.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
};
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_BODY_BYTES = 10_000;
const MAX_URL_LENGTH = 2048;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function defaultRunAudit({ type, target, baseUrl }, { allowLocal }) {
  return type === 'api'
    ? auditApi({ source: target, baseUrl, allowLocal })
    : auditFrontend({ url: target, allowLocal });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (tooBig) return;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function httpUrl(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new HttpError(400, `${field} must be a URL`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, `${field} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, `${field} must start with http:// or https://`);
  }
  return url.toString();
}

function parseRequest(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be a JSON object');
  if (!['api', 'web'].includes(body.type)) throw new HttpError(400, 'type must be "api" or "web"');
  return {
    type: body.type,
    target: httpUrl(body.target, 'target'),
    baseUrl: body.type === 'api' && body.baseUrl ? httpUrl(body.baseUrl, 'baseUrl') : undefined,
    ai: body.ai !== false,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, 'The audit took too long')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createApp({
  runAudit = defaultRunAudit,
  summarizeFn = summarize,
  apiKey,
  model,
  allowLocal = false,
  extraHosts = [],
  rateLimit = { max: 10, windowMs: 60_000 },
  maxConcurrent = 2,
  timeoutMs = 90_000,
  now = Date.now,
} = {}) {
  const hits = new Map();
  let active = 0;

  const hostAllowed = (host = '') => LOCAL_HOST.test(host) || extraHosts.includes(host.toLowerCase());

  function rateLimited(ip) {
    const t = now();
    const recent = (hits.get(ip) || []).filter((time) => t - time < rateLimit.windowMs);
    const limited = recent.length >= rateLimit.max;
    if (!limited) recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 1000) {
      for (const [key, times] of hits) if (!times.some((time) => t - time < rateLimit.windowMs)) hits.delete(key);
    }
    return limited;
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  async function handleAudit(req, res) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    const request = parseRequest(await readJson(req));
    if (rateLimited(req.socket.remoteAddress)) throw new HttpError(429, 'Too many audits, wait a minute');
    if (active >= maxConcurrent) throw new HttpError(503, 'The server is busy, try again shortly');

    active += 1;
    try {
      let result;
      try {
        result = await withTimeout(runAudit(request, { allowLocal }), timeoutMs);
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(422, error.message);
      }
      const summary = await summarizeFn(result, { apiKey: request.ai ? apiKey : undefined, model });
      send(res, 200, { result, summary, markdown: toMarkdown(result, summary.text) });
    } finally {
      active -= 1;
    }
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'Host not allowed');
    const { pathname } = new URL(req.url, 'http://localhost');

    if (STATIC[pathname]) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const [file, type, cache] = STATIC[pathname];
      const headers = { 'content-type': type, ...(cache && { 'cache-control': cache }) };
      return send(res, 200, await fs.readFile(path.join(PUBLIC_DIR, file)), headers);
    }
    if (pathname === '/api/config') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { ai: Boolean(apiKey), allowLocal });
    }
    if (pathname === '/api/audit') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      return handleAudit(req, res);
    }
    throw new HttpError(404, 'Not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : error.message });
      if (status === 500) console.error(error);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4317;
  const app = createApp({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || undefined,
    allowLocal: process.env.ALLOW_LOCAL === '1',
    extraHosts: (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  });
  app.listen(port, '127.0.0.1', () => console.log(`QA Audit Agent UI on http://localhost:${port}`));
}

module.exports = { createApp };
