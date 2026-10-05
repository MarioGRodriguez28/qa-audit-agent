# QA Audit Agent

[![CI](https://github.com/MarioGRodriguez28/qa-audit-agent/actions/workflows/test.yml/badge.svg)](https://github.com/MarioGRodriguez28/qa-audit-agent/actions/workflows/test.yml)

Tool that audits an API and a web page, scores each from 0 to 100 and writes a report that a non-technical client can read. It runs as a command line tool or as a local web interface.

- `api` reads an OpenAPI spec, probes every GET endpoint and checks the responses against the spec.
- `web` opens a page in a real browser (Playwright) and checks console errors, failed resources, broken links, accessibility (axe-core) and basic SEO.

The checks are deterministic and run with no API key. An optional language model (Gemini) only writes the plain-language summary at the top of the report. If the key is missing or the call fails, the report falls back to a template, so an audit never depends on the model.

## Quick start

```bash
npm install
npx playwright install chromium     # only needed for the web audit

npm run audit -- api https://petstore3.swagger.io/api/v3/openapi.json --out reports/petstore
npm run audit -- web https://example.com --out reports/example
```

Real runs are saved in [examples/petstore](examples/petstore/report.md) and [examples/web-landing](examples/web-landing/report.md).

### Web interface

```bash
npm run ui          # http://localhost:4317, or PORT=8080 npm run ui
```

Pick API or web page, run the audit, read the score and findings, and download `report.md` or `report.json`. It listens on 127.0.0.1 only and runs the same checks as the CLI.

The interface is a measurement sheet rather than a dashboard: a graduated ruler for the score, a timing chart of every request with a different fill per status class (so it does not rely on color alone), light and dark themes, and a print stylesheet for handing the report to a client. It is about 62 KB in total with no third-party requests. The font is JetBrains Mono (SIL Open Font License).

To enable the AI summary, copy `.env.example` to `.env` and set `GEMINI_API_KEY`. The file is git-ignored.

## API audit

| Check | Severity |
|---|---|
| Server error (5xx) | high |
| Request failed or timed out | high |
| Body is not valid JSON when the spec says JSON | high |
| Response does not match the schema in the spec | medium |
| Status code not documented in the spec | medium |
| Unexpected content type | medium |
| Slow response (default over 1000 ms) | medium |
| Missing `X-Content-Type-Options`, HSTS, or CORS open to any origin | low |

## Web audit

| Check | Severity |
|---|---|
| Page returns an error status | high |
| Accessibility violations (axe-core): critical / serious / moderate and minor | high / medium / low |
| JavaScript errors in the console | medium |
| Resources that fail to load (4xx, 5xx, network) | medium |
| Broken links (up to 25 per page) | medium |
| HTTP resources on an HTTPS page | medium |
| Slow page load (default over 3000 ms) | medium |
| Missing meta description, missing or repeated h1 | low |
| Requests to private addresses that the guard blocked | info |

Score starts at 100 and loses 15 per high, 7 per medium and 2 per low finding. Grades go from A (90+) to F.

## Options

```
qa-audit api <openapi.json | url> [options]
qa-audit web <url> [options]

  --base-url <url>   (api) Override the server URL from the spec
  --out <dir>        Write report.md and report.json
  --slow-ms <n>      Slow response / page load threshold
  --max-links <n>    (web) Maximum number of links to check
  --no-ai            Skip the AI summary
  --allow-local      Allow localhost / private addresses (development only)
```

The exit code is 2 when there is at least one high severity finding, so it can gate a CI pipeline.

## Safety

- The API audit only sends GET requests, so a third-party API is never modified.
- Targets that are localhost or resolve to private addresses are refused. In the web audit the same guard runs on every request the page makes, and redirects are followed by the tool itself with each hop validated before the browser sees it, so a public page cannot reach internal services directly or through a redirect chain. Links and API endpoints are checked without following redirects.
- Audit data is sent to the model as untrusted input, and only finding metadata is sent, never response bodies.
- The API key goes in a request header, not in the URL, and never reaches the browser: the interface only learns whether a key exists.
- Web interface: binds to 127.0.0.1, rejects foreign `Host` headers (DNS rebinding) and non-JSON requests (cross-site form posts), accepts only http(s) URLs (so no local file paths), caps the body size, rate limits per client, limits concurrent audits, applies a timeout, and ships a strict Content-Security-Policy. Audited data is rendered as text, never as HTML. The local-address guard can only be switched off with the `ALLOW_LOCAL=1` environment variable, never from a request.

Known limit: addresses are checked before each request, not pinned during it, so a hostile DNS server could still change its answer in between. A public deployment should add network egress rules.

## Tests

```bash
npm test
```

89 tests: scoring, schema validation, SSRF guard, the API audit end to end with the network mocked, and the web audit running a real Chromium against a local fixture server (clean page, broken page, error status, private targets, blocked private sub-requests, and redirects to private addresses including chains), the HTTP server (validation, rate limit, concurrency, host and content-type checks), and the interface in a real browser, including checks that it passes its own web audit in light and dark mode and does not overflow on a phone.

## Roadmap

- Public deployment: container image, network egress rules and authentication in front of the interface
- Multi-page crawl for the web audit
- Non-GET checks against a sandbox the user owns

## License

MIT
