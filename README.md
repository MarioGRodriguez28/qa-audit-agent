# QA Audit Agent

[![CI](https://github.com/MarioGRodriguez28/qa-audit-agent/actions/workflows/test.yml/badge.svg)](https://github.com/MarioGRodriguez28/qa-audit-agent/actions/workflows/test.yml)

Tool that audits an API and a web page, and can also explore a whole site and write and run functional tests for it by itself. Reports are readable by a non-technical client. It runs as a command line tool or as a local web interface.

- `api` reads an OpenAPI spec, probes every GET endpoint and checks the responses against the spec.
- `web` opens a page in a real browser (Playwright) and checks console errors, failed resources, broken links, accessibility (axe-core) and basic SEO.
- `explore` crawls a site, builds a model of what it finds (pages, links, forms, API calls), generates functional tests from that model, runs them, and exports them as a Playwright spec you can keep.

The checks are deterministic and run with no API key. An optional language model (Gemini) only writes the plain-language summary at the top of the report. If the key is missing or the call fails, the report falls back to a template, so an audit never depends on the model.

## Quick start

```bash
npm install
npx playwright install chromium     # only needed for the web audit

npm run audit -- api https://petstore3.swagger.io/api/v3/openapi.json --out reports/petstore
npm run audit -- web https://example.com --out reports/example
npm run audit -- explore https://quotes.toscrape.com/ --out reports/quotes
```

Real runs are saved in [examples/petstore](examples/petstore/report.md), [examples/web-landing](examples/web-landing/report.md) and [examples/explore-quotes](examples/explore-quotes/report.md) (with the generated [Playwright spec](examples/explore-quotes/generated.spec.js)).

### Web interface

```bash
npm run ui          # http://localhost:4317, or PORT=8080 npm run ui
```

Pick API, web page or site, run it, read the score and findings, and download `report.md`, `report.json` or, for a site, the generated `generated.spec.js`. It listens on 127.0.0.1 only and runs the same checks as the CLI.

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

## Site exploration: tests that write themselves

```bash
npm run audit -- explore https://your-site.example/ --out reports/site
```

What it does, with no test written by hand:

1. **Explores.** Crawls same-origin pages (default 12 pages, 2 levels deep) in a real browser and records, for each page: title, headings, links, forms with every field and its rules, and the JSON calls the page makes to its own API (with the shape of each response).
2. **Generates tests** from that model:

| Test | What it asserts |
|---|---|
| Page loads | status below 400, a title, no console errors, no failed resources |
| Page structure | exactly one h1, a `lang` attribute, a viewport tag |
| Accessibility | no serious or critical axe-core violations |
| Links | each linked URL that was not crawled responds below 400 |
| Navigation | clicking a main-menu link ends on the page it points to |
| Form: required | an empty form is blocked and every required field reports it |
| Form: validation | email, URL, number range and minimum length reject bad input and accept good input |
| Form: valid data | a correctly filled form passes validation |
| API contract | each JSON response keeps the shape it had when seen |
| Baseline | against a saved run: no page lost, titles and headings unchanged, no link or form field removed |

3. **Runs them** and writes `report.md` (identical problems across pages are reported once, with the pages they affect), `report.json`, a screenshot for each failure and `site-model.json`.
4. **Exports** `generated.spec.js`, the same tests as a standalone Playwright Test file. Run it anywhere with `BASE_URL=https://staging.example npx playwright test` (needs `@playwright/test` and `@axe-core/playwright`). A test checks that the exported file and the tool agree on what passes and what fails.
5. **Saves a baseline** (`baseline.json`) on the first run. Later runs compare against it, which is how it catches regressions: a page that disappears, a title or heading that changes, a removed form field, an API response that changed shape. Use `--update-baseline` to accept the current state.

For a site behind a login, save a session once and pass it in; credentials never go in a command or a file of this project:

```bash
npx playwright codegen --save-storage=auth.json https://your-site.example/login
npm run audit -- explore https://your-site.example/ --storage-state auth.json
```

If the crawl is redirected to a login page, the report says so instead of pretending the site was covered.

**What this can and cannot tell you.** The generated tests assert what the site declares about itself (a field marked required, a link that points somewhere, an API response that had a shape yesterday). They find broken pages, broken links, missing validation, accessibility problems and regressions. They cannot know business rules: whether a price is correct or a workflow does what the business wants still needs a test written by someone who knows the expected result.

Safe by construction: it never submits a form, never clicks a button, skips links that look like sign-out or delete, makes only GET requests, and applies the same private-address guard as the other modes. A test confirms that a site with a contact form receives no POST and that its sign-out URL is never requested.

## Options

```
qa-audit api <openapi.json | url> [options]
qa-audit web <url> [options]
qa-audit explore <url> [options]

  --base-url <url>   (api) Override the server URL from the spec
  --out <dir>        Write report.md and report.json
  --slow-ms <n>      Slow response / page load threshold
  --max-links <n>    (web) Maximum number of links to check
  --max-pages <n>    (explore) Pages to crawl (default 12)
  --depth <n>        (explore) Link depth from the start page (default 2)
  --storage-state <f>(explore) Saved login session (Playwright storage state)
  --baseline <file>  (explore) Baseline to compare against (default <out>/baseline.json)
  --update-baseline  (explore) Overwrite the baseline with this run
  --no-ai            Skip the AI summary
  --allow-local      Allow localhost / private addresses (development only)
```

The exit code is 2 when there is at least one high severity finding (`explore`: when any generated test fails), so it can gate a CI pipeline.

## Safety

- The API audit and the site exploration only send GET requests, so a third-party site or API is never modified. Exploration never submits a form or clicks a button.
- Targets that are localhost or resolve to private addresses are refused. In the web audit the same guard runs on every request the page makes, and redirects are followed by the tool itself with each hop validated before the browser sees it, so a public page cannot reach internal services directly or through a redirect chain. Links and API endpoints are checked without following redirects.
- Audit data is sent to the model as untrusted input, and only finding metadata is sent, never response bodies.
- The API key goes in a request header, not in the URL, and never reaches the browser: the interface only learns whether a key exists.
- Web interface: binds to 127.0.0.1, rejects foreign `Host` headers (DNS rebinding) and non-JSON requests (cross-site form posts), accepts only http(s) URLs (so no local file paths), caps the body size, rate limits per client, limits concurrent audits, applies a timeout, and ships a strict Content-Security-Policy. Audited data is rendered as text, never as HTML. The local-address guard can only be switched off with the `ALLOW_LOCAL=1` environment variable, never from a request.

Known limit: addresses are checked before each request, not pinned during it, so a hostile DNS server could still change its answer in between. A public deployment should add network egress rules.

## Tests

```bash
npm test
```

104 tests: scoring, schema validation, SSRF guard, the API audit end to end with the network mocked, and the web audit running a real Chromium against a local fixture server (clean page, broken page, error status, private targets, blocked private sub-requests, and redirects to private addresses including chains), the HTTP server (validation, rate limit, concurrency, host and content-type checks), the interface in a real browser, including checks that it passes its own web audit in light and dark mode and does not overflow on a phone, and the site exploration against a fixture site with known defects (what it finds, what it must not touch, baseline regressions, and the exported spec running under Playwright Test with the same results).

## Roadmap

- Public deployment: container image, network egress rules and authentication in front of the interface
- AI-drafted scenarios from an OpenAPI spec, to be reviewed before use
- Login flows driven by environment credentials
- Non-GET checks against a sandbox the user owns

## License

MIT
