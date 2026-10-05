# QA Audit Agent

[![CI](https://github.com/MarioGRodriguez28/qa-audit-agent/actions/workflows/test.yml/badge.svg)](https://github.com/MarioGRodriguez28/qa-audit-agent/actions/workflows/test.yml)

Command line tool that audits an API from its OpenAPI spec. It probes every GET endpoint, checks the responses against the spec, scores the result from 0 to 100 and writes a report that a non-technical client can read.

The checks are deterministic and run with no API key. An optional language model (Gemini) only writes the plain-language summary at the top of the report. If the key is missing or the call fails, the report falls back to a template, so the audit never depends on the model.

## Quick start

```bash
npm install
npm run audit -- https://petstore3.swagger.io/api/v3/openapi.json --out reports/petstore
```

A real run is saved in [examples/petstore](examples/petstore/report.md).

To enable the AI summary, copy `.env.example` to `.env` and set `GEMINI_API_KEY`. The file is git-ignored.

## What it checks

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

Score starts at 100 and loses 15 per high, 7 per medium and 2 per low finding. Grades go from A (90+) to F.

## Options

```
qa-audit <openapi.json | url> [options]

  --base-url <url>   Override the server URL from the spec
  --out <dir>        Write report.md and report.json
  --slow-ms <n>      Slow response threshold
  --no-ai            Skip the AI summary
  --allow-local      Allow localhost / private addresses (development only)
```

The exit code is 2 when there is at least one high severity finding, so it can gate a CI pipeline.

## Safety

- Only GET requests are sent, so a third-party API is never modified.
- Targets that are localhost or resolve to private addresses are refused, which blocks using the tool to reach internal services. Redirects are not followed.
- Audit data is sent to the model as untrusted input, and only finding metadata is sent, never response bodies.
- The API key goes in a request header, not in the URL.

Known limit: the address is checked before the request, not pinned during it, so a hostile DNS server could still change its answer in between. A public deployment should add network egress rules.

## Tests

```bash
npm test
```

34 tests with the network mocked: scoring, schema validation, SSRF guard, the audit flow end to end, model fallback and report output.

## Roadmap

- Frontend audit with Playwright (console errors, broken links, forms, accessibility)
- Web interface with a serverless endpoint and rate limiting
- Non-GET checks against a sandbox the user owns

## License

MIT
