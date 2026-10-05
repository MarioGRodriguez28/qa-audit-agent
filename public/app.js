(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('audit-form');
  const examples = {
    api: 'https://petstore3.swagger.io/api/v3/openapi.json',
    web: 'https://example.com',
  };
  const labels = {
    api: ['OpenAPI spec URL (JSON)', 'https://petstore3.swagger.io/api/v3/openapi.json'],
    web: ['Page URL', 'https://example.com'],
  };
  let lastReport = null;

  // Audited data is untrusted, so everything is written with textContent, never as HTML.
  function el(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    children.forEach((child) => node.append(child));
    return node;
  }

  const currentType = () => form.elements.type.value;

  function syncType() {
    const type = currentType();
    $('target-label').textContent = labels[type][0];
    $('target').placeholder = labels[type][1];
    $('base-field').hidden = type !== 'api';
  }

  function setBusy(busy, message = '') {
    $('run').disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    $('status').textContent = message;
  }

  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = !message;
  }

  function render({ result, summary, markdown }) {
    lastReport = { result, summary, markdown };
    $('score').textContent = String(result.score);
    $('grade').textContent = result.grade;
    $('score-meter').value = result.score;
    $('target-line').textContent = `${result.specTitle} - ${result.target} - ${result.scannedAt}`;
    $('summary').textContent = summary.text;
    $('summary-source').textContent =
      summary.source === 'llm' ? 'Summary written by the AI model.' : 'Summary generated from a template.';

    const findings = $('findings');
    findings.replaceChildren();
    if (!result.findings.length) findings.append(el('li', { className: 'empty', text: 'No issues found.' }));
    const order = { high: 0, medium: 1, low: 2, info: 3 };
    [...result.findings]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .forEach((f) => {
        const body = el('div', {}, [
          el('span', { className: 'finding-title', text: f.title }),
          el('span', { className: 'finding-meta', text: `${f.endpoint} - ${f.detail}` }),
        ]);
        findings.append(el('li', {}, [el('span', { className: `badge ${f.severity}`, text: f.severity }), body]));
      });

    const rows = $('requests');
    rows.replaceChildren();
    result.endpoints.forEach((e) => {
      rows.append(
        el('tr', {}, [
          el('td', { text: e.endpoint }),
          el('td', { text: e.status === null ? 'error' : String(e.status) }),
          el('td', { text: `${e.durationMs} ms` }),
          el('td', { text: String(e.issues) }),
        ]),
      );
    });

    $('results').hidden = false;
    $('results-title').focus();
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = el('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function run(event) {
    event.preventDefault();
    showError('');
    const type = currentType();
    const target = $('target').value.trim();
    if (!target) {
      showError('Enter a URL to audit.');
      $('target').focus();
      return;
    }
    $('results').hidden = true;
    setBusy(true, type === 'web' ? 'Running audit in a real browser, this can take up to a minute...' : 'Running audit...');
    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          target,
          baseUrl: type === 'api' ? $('base-url').value.trim() || undefined : undefined,
          ai: $('ai').checked,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      render(data);
      setBusy(false, 'Audit finished.');
    } catch (error) {
      setBusy(false);
      showError(error.message);
    }
  }

  form.addEventListener('submit', run);
  form.elements.type.forEach((radio) => radio.addEventListener('change', syncType));
  $('example-api').addEventListener('click', () => {
    form.elements.type.value = 'api';
    syncType();
    $('target').value = examples.api;
  });
  $('example-web').addEventListener('click', () => {
    form.elements.type.value = 'web';
    syncType();
    $('target').value = examples.web;
  });
  $('download-md').addEventListener('click', () => lastReport && download('report.md', lastReport.markdown, 'text/markdown'));
  $('download-json').addEventListener('click', () =>
    lastReport && download('report.json', JSON.stringify({ ...lastReport.result, summary: lastReport.summary.text }, null, 2), 'application/json'),
  );

  fetch('/api/config')
    .then((res) => res.json())
    .then((config) => {
      if (!config.ai) {
        $('ai').checked = false;
        $('ai').disabled = true;
        $('ai-help').hidden = false;
      }
    })
    .catch(() => {});
  syncType();
})();
