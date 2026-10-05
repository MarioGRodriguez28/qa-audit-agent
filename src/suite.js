const { explore } = require('./explore');
const { generateTests } = require('./generate');
const { runSuite } = require('./runner');
const { exportPlaywrightSpec } = require('./export');

async function exploreAndRun({ url, allowLocal = false, maxPages, depth, baseline, contextOptions, outDir, lookup, launch }) {
  const model = await explore({ url, allowLocal, maxPages, depth, contextOptions, lookup, launch });
  const cases = generateTests(model, { baseline });
  const result = await runSuite({ model, cases, allowLocal, contextOptions, outDir, lookup, launch });
  return { model, cases, result, spec: exportPlaywrightSpec(cases, model) };
}

module.exports = { exploreAndRun };
