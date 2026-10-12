/**
 * Inventory of the native-legacy gauge page (native-legacy.html, E0).
 *
 * Loads the page ONCE with a filter that matches no test, waits for every
 * test file to settle, and writes a JSON inventory:
 *   - modules:     QUnit module name -> { tests, file }  (file = the test file
 *                  that registered it, from window.__nativeLegacy.moduleFiles)
 *   - loadErrors:  test file -> the error that kept it from loading on native
 *   - failedRequests / httpErrors: the dev-server requests that failed (a vite
 *                  transform error surfaces in the browser only as "Failed to
 *                  fetch dynamically imported module: <test file>"; the failed
 *                  dependency request names the real culprit)
 *
 * Usage (native vite already up on :5181):
 *   node scripts/gxt-test-runner/native-legacy-inventory.mjs \
 *     [--url http://localhost:5181/native-legacy.html] [--out <file.json>] [--timeout <ms>]
 *
 * If the page never settles, the renderer is paused over CDP and its JS stack
 * plus the still-pending test files are printed before exiting non-zero.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const args = {
    url: 'http://localhost:5181/native-legacy.html',
    out: 'test-results/native-legacy-inventory.json',
    timeout: 600_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  const failedRequests = [];
  const httpErrors = [];
  const consoleErrors = [];
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText || 'unknown' });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) httpErrors.push({ url: res.url(), status: res.status() });
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 2000));
  });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.stack || err.message}`));

  const sep = args.url.includes('?') ? '&' : '?';
  const started = Date.now();
  await page.goto(args.url + sep + 'filter=__native_legacy_inventory__', {
    timeout: 300_000,
    waitUntil: 'load',
  });
  // QUnit starts only after every test file settled (native-legacy.html).
  try {
    await page.waitForFunction(
      () => !!(window.__nativeLegacy && window.__nativeLegacy.settled),
      undefined,
      { timeout: args.timeout, polling: 1000 }
    );
  } catch (err) {
    await dumpHang(page);
    throw err;
  }
  const state = await page.evaluate(() => {
    const files = window.__nativeLegacy.moduleFiles;
    const modules = {};
    for (const m of QUnit.config.modules) {
      if (!m.name) continue;
      const entry =
        modules[m.name] || (modules[m.name] = { tests: 0, file: files[m.name] ?? null });
      entry.tests += m.tests.length;
    }
    return { modules, loadErrors: { ...window.__nativeLegacy.loadErrors } };
  });
  const inventory = {
    url: args.url,
    capturedAt: new Date().toISOString(),
    loadMs: Date.now() - started,
    moduleCount: Object.keys(state.modules).length,
    testCount: Object.values(state.modules).reduce((a, m) => a + m.tests, 0),
    loadErrorCount: Object.keys(state.loadErrors).length,
    ...state,
    failedRequests,
    httpErrors,
    consoleErrors,
  };
  const outPath = resolve(process.cwd(), args.out);
  writeFileSync(outPath, JSON.stringify(inventory, null, 2));
  process.stdout.write(
    `[inventory] ${inventory.moduleCount} modules / ${inventory.testCount} tests, ` +
      `${inventory.loadErrorCount} test file(s) failed to load, ` +
      `${failedRequests.length} failed request(s), ${httpErrors.length} HTTP error(s) ` +
      `in ${(inventory.loadMs / 1000).toFixed(1)}s -> ${outPath}\n`
  );
} catch (err) {
  process.stderr.write(`[inventory] failed: ${err.stack || err}\n`);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);

// The page never settled: pause the renderer (works even inside a JS spin)
// and print where it is, plus the test files whose import is still pending.
async function dumpHang(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  const paused = new Promise((resolvePaused) => cdp.once('Debugger.paused', resolvePaused));
  await cdp.send('Debugger.pause');
  const event = await Promise.race([
    paused,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 10_000)),
  ]);
  if (!event) {
    process.stderr.write('[inventory] hang: renderer idle (no JS to pause) — waiting on I/O\n');
    const pending = await page.evaluate(() =>
      window.__nativeLegacy ? [...window.__nativeLegacy.pending] : null
    );
    process.stderr.write(`[inventory] pending imports: ${JSON.stringify(pending)}\n`);
    return;
  }
  process.stderr.write('[inventory] hang: renderer paused in JS; top frames:\n');
  for (const frame of event.callFrames.slice(0, 25)) {
    const { lineNumber, columnNumber } = frame.location;
    process.stderr.write(
      `  ${frame.functionName || '<anonymous>'}  ${frame.url}:${lineNumber + 1}:${columnNumber + 1}\n`
    );
  }
  const top = event.callFrames[0];
  const { result } = await cdp.send('Debugger.evaluateOnCallFrame', {
    callFrameId: top.callFrameId,
    expression: 'JSON.stringify(window.__nativeLegacy ? [...window.__nativeLegacy.pending] : null)',
    returnByValue: true,
  });
  process.stderr.write(`[inventory] pending imports: ${result.value}\n`);
  await cdp.send('Debugger.resume');
}
