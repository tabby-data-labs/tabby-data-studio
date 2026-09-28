/**
 * Automated performance gate. Boots the real app, drives the same bench button a
 * user would click, and fails the build if the paint budget is exceeded.
 *
 *   npm run bench
 *
 * GRID-SPEC §11 makes perf a measured invariant rather than an impression, so
 * this runs in CI alongside the smoke test.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySecurityGuards } from './security/navigation';

const target =
  process.env['TABBY_BENCH_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;

/** 600 frames at 60fps is 10s; allow generous headroom for cold caches and CI. */
const TIMEOUT_MS = 120_000;
const POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  applySecurityGuards('prod');

  const win = new BrowserWindow({
    // Shown on purpose: a hidden window can have its rAF throttled, which would
    // make the sustained-fps figure meaningless.
    show: true,
    width: 1440,
    height: 900,
    backgroundColor: '#030b16',
    title: 'Tabby — bench',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const errors: string[] = [];
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: number; message?: string } | undefined;
    const level =
      typeof first?.level === 'number' ? first.level : typeof args[1] === 'number' ? args[1] : 0;
    const message =
      typeof first?.message === 'string'
        ? first.message
        : typeof args[2] === 'string'
          ? args[2]
          : '';
    if (level >= 2) errors.push(message.slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`renderer gone: ${details.reason}`);
  });

  await win.loadURL(target);
  await sleep(1500);

  const clicked = (await win.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const bench = buttons.find((b) => b.textContent.includes('bench'));
    if (!bench) return false;
    bench.click();
    return true;
  })()`)) as boolean;

  if (!clicked) {
    process.stdout.write('FAIL: bench button not found in the toolbar\n');
    app.exit(1);
    return;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let resultJson = '';
  while (Date.now() < deadline) {
    resultJson = (await win.webContents.executeJavaScript(
      `document.querySelector('[data-bench-json]')?.textContent ?? ''`,
    )) as string;
    if (resultJson.trim() !== '') break;
    await sleep(POLL_MS);
  }

  if (resultJson.trim() === '') {
    process.stdout.write(`FAIL: bench produced no result within ${TIMEOUT_MS}ms\n`);
    app.exit(1);
    return;
  }

  const result = JSON.parse(resultJson) as {
    frames: number;
    p50: number;
    p95: number;
    p99: number;
    dropped: number;
    measureTextCalls: number;
    measureTextMisses: number;
    sustainedFps: number;
    budgetP95Ms: number;
    withinBudget: boolean;
    missesPerFrame: number;
    withinMeasureBudget: boolean;
  };

  const failures: string[] = [];
  if (!result.withinBudget) {
    failures.push(`p95 paint ${result.p95.toFixed(2)}ms exceeds ${result.budgetP95Ms}ms budget`);
  }
  if (result.frames < 100) {
    failures.push(`only ${result.frames} frames recorded; expected at least 100`);
  }
  // Zero lookups means nothing was painted, so every timing above is meaningless.
  if (result.measureTextCalls === 0) {
    failures.push('no text was measured — the grid painted nothing');
  }
  if (!result.withinMeasureBudget) {
    failures.push(
      `${result.missesPerFrame.toFixed(0)} measureText misses per frame exceeds the 2000 budget`,
    );
  }
  failures.push(...errors.map((message) => `console: ${message}`));

  process.stdout.write(`${JSON.stringify({ target, result, errors, failures }, null, 2)}\n`);

  app.exit(failures.length > 0 ? 1 : 0);
});
