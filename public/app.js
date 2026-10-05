(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('audit-form');
  const examples = {
    api: 'https://petstore3.swagger.io/api/v3/openapi.json',
    web: 'https://example.com',
    explore: 'https://quotes.toscrape.com/',
  };
  const labels = {
    api: ['OpenAPI spec URL (JSON)', 'https://petstore3.swagger.io/api/v3/openapi.json'],
    web: ['Page URL', 'https://example.com'],
    explore: ['Start URL (same-site pages are crawled)', 'https://quotes.toscrape.com/'],
  };
  const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
  let lastReport = null;
  const BUSY_TEXT = {
    api: 'Running audit.',
    web: 'Running audit in a real browser. This can take up to a minute.',
    explore: 'Crawling the site, generating tests and running them. This can take a couple of minutes.',
  };
  let clockTimer = null;

  // Audited data is untrusted, so everything is written with textContent, never as HTML.
  function el(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    children.forEach((child) => node.append(child));
    return node;
  }

  const currentType = () => form.elements.type.value;
  const pad = (n) => String(n).padStart(2, '0');

  function syncType() {
    const type = currentType();
    $('target-label').textContent = labels[type][0];
    $('target').placeholder = labels[type][1];
    $('base-field').hidden = type !== 'api';
    $('target-help').textContent =
      type === 'explore'
        ? 'Same-site pages only (up to 12). Nothing is submitted and nothing is deleted. http(s) only; private addresses are blocked.'
        : 'http(s) only. Private and local addresses are blocked.';
  }

  function startClock() {
    const started = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      $('clock').textContent = `Elapsed ${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
    };
    tick();
    $('clock').hidden = false;
    clockTimer = setInterval(tick, 1000);
  }

  function stopClock() {
    clearInterval(clockTimer);
    $('clock').hidden = true;
  }

  function setBusy(busy, message = '') {
    $('run').disabled = busy;
    $('scan').hidden = !busy;
    form.setAttribute('aria-busy', String(busy));
    $('status').textContent = message;
    if (busy) startClock();
    else stopClock();
  }

  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = !message;
  }

  const statusClass = (status) => {
    if (status === null) return 'err';
    if (status >= 500) return 's5';
    if (status >= 400) return 's4';
    if (status >= 300) return 's3';
    return 's2';
  };

  const zoneFor = (score) => (score >= 90 ? 'a' : score >= 75 ? 'b' : score >= 60 ? 'c' : score >= 40 ? 'd' : 'f');

  function renderRuler(score) {
    document.querySelectorAll('#ruler .labels li').forEach((li, i) => li.style.setProperty('--x', String(i * 10)));
    document.querySelectorAll('#ruler .zones li').forEach((li) => li.classList.toggle('on', li.className.includes(`z-${zoneFor(score)}`)));
    const marker = $('marker');
    marker.style.setProperty('--p', '0');
    requestAnimationFrame(() => requestAnimationFrame(() => marker.style.setProperty('--p', String(score))));
  }

  function render({ result, summary, markdown, spec }) {
    lastReport = { result, summary, markdown, spec };
    const suite = result.kind === 'suite';
    $('r-target').textContent = result.target;
    $('r-type').textContent = suite ? 'Generated suite' : result.kind === 'frontend' ? 'Web page' : 'API';
    $('r-count-label').textContent = suite ? 'Tests' : 'Requests';
    $('requests-title').textContent = suite ? 'Pages explored' : 'Requests checked';
    $('download-spec').hidden = !spec;
    $('r-scanned').textContent = `${new Date(result.scannedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    $('r-count').textContent = suite ? `${result.summary.passed}/${result.summary.total} passed` : String(result.endpoints.length);
    $('score').textContent = String(result.score);
    $('grade').textContent = result.grade;
    $('summary').textContent = summary.text;
    $('summary-source').textContent =
      summary.source === 'llm' ? 'Summary written by the AI model.' : 'Summary generated from a template.';
    renderRuler(result.score);

    const findings = $('findings');
    findings.replaceChildren();
    $('findings-count').textContent = String(result.findings.length).padStart(2, '0');
    $('findings-title').firstChild.textContent = suite ? 'Failed tests ' : 'Findings ';
    if (!result.findings.length) findings.append(el('li', { className: 'empty', text: suite ? 'All generated tests passed.' : 'No issues found.' }));
    [...result.findings]
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .forEach((f) => {
        const body = el('div', {}, [
          el('span', { className: 'finding-title', text: f.title }),
          el('span', { className: 'finding-meta', text: `${f.endpoint} - ${f.detail}` }),
        ]);
        findings.append(el('li', {}, [el('span', { className: `badge ${f.severity}`, text: f.severity }), body]));
      });

    const rows = $('requests');
    rows.replaceChildren();
    const slowest = Math.max(1, ...result.endpoints.map((e) => e.durationMs));
    result.endpoints.forEach((e) => {
      const bar = el('span', { className: `tl ${statusClass(e.status)}` });
      bar.setAttribute('aria-hidden', 'true');
      bar.style.setProperty('--w', String(Math.max(1, Math.round((e.durationMs / slowest) * 100))));
      rows.append(
        el('tr', {}, [
          el('td', { text: e.endpoint }),
          el('td', { text: e.status === null ? 'error' : String(e.status) }),
          el('td', { text: `${e.durationMs} ms` }),
          el('td', { text: String(e.issues) }),
          el('td', {}, [bar]),
        ]),
      );
    });

    $('empty').hidden = true;
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
    $('empty').hidden = false;
    setBusy(true, BUSY_TEXT[type]);
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
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`The server did not answer with JSON (status ${response.status}). Check that this page is served by the QA Audit server.`);
      }
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
  $('example-site').addEventListener('click', () => {
    form.elements.type.value = 'explore';
    syncType();
    $('target').value = examples.explore;
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
  $('download-spec').addEventListener('click', () => lastReport?.spec && download('generated.spec.js', lastReport.spec, 'text/javascript'));
  $('print').addEventListener('click', () => window.print());

  fetch('/api/config')
    .then((res) => res.json())
    .then((config) => {
      $('mode-badge').textContent = config.ai ? 'AI summary on' : 'template summary';
      if (!config.ai) {
        $('ai').checked = false;
        $('ai').disabled = true;
        $('ai-help').hidden = false;
      }
    })
    .catch(() => {});
  syncType();
})();
