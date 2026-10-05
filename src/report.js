const ORDER = { high: 0, medium: 1, low: 2 };

function toMarkdown(result, summary) {
  const findings = [...result.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const out = [
    `# API audit: ${result.specTitle}`,
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
  out.push('', '## Endpoints checked', '', '| Endpoint | Status | Time | Issues |', '|---|---|---|---|');
  for (const e of result.endpoints) {
    out.push(`| \`${e.endpoint}\` | ${e.status ?? 'error'} | ${e.durationMs} ms | ${e.issues} |`);
  }
  return out.join('\n') + '\n';
}

function toJson(result, summary) {
  return JSON.stringify({ ...result, summary }, null, 2);
}

module.exports = { toMarkdown, toJson };
