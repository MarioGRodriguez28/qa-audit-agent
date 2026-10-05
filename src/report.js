const ORDER = { high: 0, medium: 1, low: 2, info: 3 };

const GROUP_TITLES = {
  page: 'Pages',
  a11y: 'Accessibility',
  navigation: 'Navigation',
  links: 'Links',
  forms: 'Forms',
  api: 'API contracts',
  baseline: 'Baseline regression',
};
const ICON = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' };
const TYPE_LABEL = {
  'page-loads': 'Page loads',
  'page-structure': 'Page structure',
  'page-a11y': 'Accessibility',
  'link-ok': 'Link',
  'nav-click': 'Navigation',
  'form-required': 'Form required fields',
  'form-validation': 'Form validation',
  'form-accepts-valid': 'Form valid data',
  'api-contract': 'API contract',
  'baseline-page': 'Baseline',
};

const pathOf = (rawUrl) => {
  const url = new URL(rawUrl);
  return url.pathname + url.search;
};

// The same problem repeated on many pages is reported once, with the pages it affects.
function groupFailures(failed) {
  const groups = new Map();
  for (const t of failed) {
    const key = `${t.type}|${t.detail.replace(/, \d+ elements?\)/g, ')').replace(/\d+ ms/g, '')}`;
    if (!groups.has(key)) groups.set(key, { first: t, tests: [] });
    groups.get(key).tests.push(t);
  }
  return [...groups.values()];
}

function suiteMarkdown(result, summary) {
  const { summary: s, site } = result;
  const out = [
    `# Generated test suite: ${result.specTitle}`,
    '',
    `Target: ${result.target}  `,
    `Scanned: ${result.scannedAt}  `,
    `Pass rate: **${result.score}% (${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.total})**`,
    '',
    `Explored ${site.pages} pages, ${site.links} links, ${site.forms} forms and ${site.apiCalls} API calls, and generated ${s.total} tests from what it found.`,
    '',
  ];
  if (site.authRequired) {
    out.push('> The crawl was redirected to a login page. Only public pages were tested; provide a saved session (--storage-state) to cover the rest.', '');
  }
  out.push('## Summary', '', summary, '', '## Failed tests', '');
  const failed = result.tests.filter((t) => t.status === 'failed');
  if (!failed.length) out.push('None.', '');
  for (const entry of groupFailures(failed)) {
    const { first, tests } = entry;
    if (tests.length === 1) {
      out.push(`- **${GROUP_TITLES[first.group] || first.group}** ${first.name}. ${first.detail}${first.screenshot ? ` (${first.screenshot})` : ''}`);
    } else {
      const where = tests.map((t) => (t.url ? pathOf(t.url) : t.name));
      const shown = where.slice(0, 4).join(', ');
      out.push(
        `- **${TYPE_LABEL[first.type] || first.type}** ${first.detail.replace(/, \d+ elements?\)/g, ')')}. ` +
          `Affects ${tests.length} pages: ${shown}${where.length > 4 ? ` and ${where.length - 4} more` : ''}.`,
      );
    }
  }
  out.push('', '## All tests', '');
  for (const group of Object.keys(GROUP_TITLES)) {
    const tests = result.tests.filter((t) => t.group === group);
    if (!tests.length) continue;
    out.push(`### ${GROUP_TITLES[group]}`, '', '| Result | Test | Time |', '|---|---|---|');
    for (const t of tests) out.push(`| ${ICON[t.status]} | ${t.name} | ${t.durationMs} ms |`);
    out.push('');
  }
  out.push('## Pages explored', '', '| Request | Status | Load | Failed tests |', '|---|---|---|---|');
  for (const e of result.endpoints) out.push(`| \`${e.endpoint}\` | ${e.status ?? 'error'} | ${e.durationMs} ms | ${e.issues} |`);
  return out.join('\n') + '\n';
}

function toMarkdown(result, summary) {
  if (result.kind === 'suite') return suiteMarkdown(result, summary);
  const findings = [...result.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const out = [
    `# ${result.kind === 'frontend' ? 'Frontend' : 'API'} audit: ${result.specTitle}`,
    '',
    `Target: ${result.target}  `,
    `Scanned: ${result.scannedAt}  `,
    `Score: **${result.score}/100 (grade ${result.grade})**`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Findings',
    '',
  ];
  if (!findings.length) out.push('No issues found.', '');
  for (const f of findings) {
    out.push(`- **${f.severity.toUpperCase()}** \`${f.endpoint}\`: ${f.title}. ${f.detail}`);
  }
  out.push('', result.kind === 'frontend' ? '## Page and links checked' : '## Endpoints checked', '', '| Request | Status | Time | Issues |', '|---|---|---|---|');
  for (const e of result.endpoints) {
    out.push(`| \`${e.endpoint}\` | ${e.status ?? 'error'} | ${e.durationMs} ms | ${e.issues} |`);
  }
  return out.join('\n') + '\n';
}

function toJson(result, summary) {
  return JSON.stringify({ ...result, summary }, null, 2);
}

module.exports = { toMarkdown, toJson };
