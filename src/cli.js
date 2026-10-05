#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { auditApi } = require('./audit');
const { auditFrontend } = require('./frontend');
const { summarize } = require('./llm');
const { toMarkdown, toJson } = require('./report');

const HELP = `Usage:
  qa-audit api <openapi.json | url> [options]   Audit an API from its OpenAPI spec
  qa-audit web <url> [options]                  Audit a web page in a real browser

Options:
  --base-url <url>   (api) Override the server URL from the spec
  --out <dir>        Write report.md and report.json to this folder
  --slow-ms <n>      Slow response / page load threshold
  --max-links <n>    (web) Maximum number of links to check (default 25)
  --no-ai            Skip the AI summary even if GEMINI_API_KEY is set
  --allow-local      Allow localhost / private addresses (development only)
  -h, --help         Show this help

The AI summary is optional: set GEMINI_API_KEY (and GEMINI_MODEL) to enable it.
Exit code is 2 when there is at least one high severity finding.`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      out: { type: 'string' },
      'slow-ms': { type: 'string' },
      'max-links': { type: 'string' },
      'no-ai': { type: 'boolean' },
      'allow-local': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  if (values.help || !['api', 'web'].includes(command) || !target || positionals.length > 2) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  const common = {
    allowLocal: values['allow-local'],
    slowMs: values['slow-ms'] ? Number(values['slow-ms']) : undefined,
  };
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
