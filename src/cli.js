#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { auditApi } = require('./audit');
const { auditFrontend } = require('./frontend');
const { exploreAndRun } = require('./suite');
const { createBaseline } = require('./generate');
const { summarize } = require('./llm');
const { toMarkdown, toJson } = require('./report');

const HELP = `Usage:
  qa-audit api <openapi.json | url> [options]   Audit an API from its OpenAPI spec
  qa-audit web <url> [options]                  Audit a web page in a real browser
  qa-audit explore <url> [options]              Crawl a site, generate functional tests and run them

Options:
  --base-url <url>   (api) Override the server URL from the spec
  --out <dir>        Write report.md and report.json to this folder
  --slow-ms <n>      Slow response / page load threshold
  --max-links <n>    (web) Maximum number of links to check (default 25)
  --max-pages <n>    (explore) Pages to crawl (default 12)
  --depth <n>        (explore) Link depth from the start page (default 2)
  --storage-state <f>(explore) Saved login session (Playwright storage state JSON)
  --baseline <file>  (explore) Compare against a saved baseline (default: <out>/baseline.json)
  --update-baseline  (explore) Overwrite the baseline with this run
  --no-ai            Skip the AI summary even if GEMINI_API_KEY is set
  --allow-local      Allow localhost / private addresses (development only)
  -h, --help         Show this help

The AI summary is optional: set GEMINI_API_KEY (and GEMINI_MODEL) to enable it.
Exit code is 2 when there is at least one high severity finding (explore: when any generated test fails).`;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
}

async function runExplore(target, values) {
  const out = values.out || path.join('reports', new URL(target).hostname.replace(/[^a-z0-9.-]/gi, '_'));
  const allowLocal = values['allow-local'];
  const contextOptions = values['storage-state'] ? { storageState: values['storage-state'] } : {};

  const baselinePath = values.baseline || path.join(out, 'baseline.json');
  const baseline = await readJson(baselinePath);

  console.error(`Exploring ${target} and running the generated tests ...`);
  const { model, result, spec } = await exploreAndRun({
    url: target,
    allowLocal,
    contextOptions,
    baseline,
    outDir: out,
    maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
    depth: values.depth ? Number(values.depth) : undefined,
  });
  if (model.authRequired) {
    console.error('Warning: the crawl was redirected to a login page. Only public pages are covered; use --storage-state to test the rest.');
  }

  const summary = await summarize(result, {
    apiKey: values['no-ai'] ? undefined : process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || undefined,
  });
  if (summary.warning) console.error(`AI summary unavailable: ${summary.warning}`);

  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'report.md'), toMarkdown(result, summary.text));
  await fs.writeFile(path.join(out, 'report.json'), toJson(result, summary.text));
  await fs.writeFile(path.join(out, 'site-model.json'), JSON.stringify(model, null, 2));
  await fs.writeFile(path.join(out, 'generated.spec.js'), spec);
  const wroteBaseline = !baseline || values['update-baseline'];
  if (wroteBaseline) await fs.writeFile(baselinePath, JSON.stringify(createBaseline(model), null, 2));

  const { passed, failed, skipped } = result.summary;
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped (${result.score}%). Output in ${out}${wroteBaseline ? ' (baseline saved)' : ''}`);
  return failed > 0 ? 2 : 0;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      out: { type: 'string' },
      'slow-ms': { type: 'string' },
      'max-links': { type: 'string' },
      'max-pages': { type: 'string' },
      depth: { type: 'string' },
      'storage-state': { type: 'string' },
      baseline: { type: 'string' },
      'update-baseline': { type: 'boolean' },
      'no-ai': { type: 'boolean' },
      'allow-local': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  if (values.help || !['api', 'web', 'explore'].includes(command) || !target || positionals.length > 2) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  const common = {
    allowLocal: values['allow-local'],
    slowMs: values['slow-ms'] ? Number(values['slow-ms']) : undefined,
  };
  if (command === 'explore') return runExplore(target, values);

  const result =
    command === 'api'
      ? await auditApi({ ...common, source: target, baseUrl: values['base-url'] })
      : await auditFrontend({
          ...common,
          url: target,
          maxLinks: values['max-links'] ? Number(values['max-links']) : undefined,
        });

  const summary = await summarize(result, {
    apiKey: values['no-ai'] ? undefined : process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || undefined,
  });
  if (summary.warning) console.error(`AI summary unavailable: ${summary.warning}`);

  const markdown = toMarkdown(result, summary.text);
  if (values.out) {
    await fs.mkdir(values.out, { recursive: true });
    await fs.writeFile(path.join(values.out, 'report.md'), markdown);
    await fs.writeFile(path.join(values.out, 'report.json'), toJson(result, summary.text));
    console.log(`Score ${result.score}/100 (${result.grade}). Report written to ${values.out}`);
  } else {
    console.log(markdown);
  }
  return result.findings.some((f) => f.severity === 'high') ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  },
);
