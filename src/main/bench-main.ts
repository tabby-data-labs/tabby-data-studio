/**
 * Automated performance gate. Boots the real app, drives the same bench button a
 * user would click, and fails the build if the paint budget is exceeded.
 *
 *   npm run bench
 *
 * GRID-SPEC §11 makes perf a measured invariant rather than an impression, so
 * this runs in CI alongside the smoke test.
 *
 * With `TABBY_TEST_PG_*` set it additionally registers the real IPC router, seeds a
 * connection, and drives the UI to open a 10M-row table before benching — so the
 * numbers describe the live path (IPC round trips, cursor FETCHes, columnar decode)
 * and not only the synthetic in-memory one. Without those variables it behaves
 * exactly as before and needs no database.
 */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySecurityGuards } from './security/navigation';
import { registerIpcHandlers } from './ipc/router';
import { createDbServices, type DbServices } from './db/services';
import { SettingsStore } from './store/settings-store';
import type { SecretCipher } from './store/cipher';

const target =
  process.env['TABBY_BENCH_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;

/** 600 frames at 60fps is 10s; allow generous headroom for cold caches and CI. */
const TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const BENCH_CONNECTION_ID = 'bench-live';
const BENCH_TABLE = process.env['TABBY_BENCH_TABLE'] ?? 'fixtures.big';

const liveUser = process.env['TABBY_TEST_PG_USER'] ?? '';
const liveDatabase = process.env['TABBY_TEST_PG_DATABASE'] ?? '';
/** Live mode is opt-in: the default bench must stay runnable with no database. */
const liveMode = liveUser !== '' && liveDatabase !== '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hard stop. A hang in this harness must fail loudly rather than consume a CI slot
 * until something external kills it — which is what happened the first time the
 * live path was added, when teardown blocked on `pool.end()`.
 */
const WATCHDOG_MS = 300_000;

function mark(stage: string): void {
  process.stdout.write(`[bench] ${stage}\n`);
}

app
  .whenReady()
  .then(async () => {
    const watchdog = setTimeout(() => {
      process.stdout.write(`FAIL: bench watchdog fired after ${WATCHDOG_MS}ms\n`);
      app.exit(1);
    }, WATCHDOG_MS);

    applySecurityGuards('prod');

    let win: BrowserWindow | null = null;
    let settingsDir: string | null = null;
    let services: DbServices | null = null;
    let disposeIpc: (() => void) | null = null;

    if (liveMode) {
      // Same wiring the app uses, so the measurement cannot drift from production.
      // The cipher is the harness's reversible stand-in: `safeStorage` needs a
      // keychain, and a benchmark has no business touching the user's.
      const cipher: SecretCipher = {
        available: true,
        encrypt: (plain) => `enc(${Buffer.from(plain, 'utf8').toString('base64')})`,
        decrypt: (ct) => Buffer.from(ct.slice(4, -1), 'base64').toString('utf8'),
      };
      settingsDir = mkdtempSync(join(tmpdir(), 'tabby-bench-'));
      const settings = new SettingsStore({ dir: settingsDir, cipher });
      services = createDbServices({ settings, emit: () => undefined });
      disposeIpc = registerIpcHandlers({
        settings,
        window: () => win,
        connections: services.connections,
        schemas: services.schemas,
        queries: services.queries,
      });
      // Saved before the renderer mounts, so the connection store's initial load
      // already sees it and the UI has something to select.
      settings.saveConnection({
        connection: {
          id: BENCH_CONNECTION_ID,
          name: 'bench live',
          host: process.env['TABBY_TEST_PG_HOST'] ?? 'localhost',
          port: Number(process.env['TABBY_TEST_PG_PORT'] ?? 5432),
          database: liveDatabase,
          user: liveUser,
          sslMode: 'disable',
          createdAt: 0,
          updatedAt: 0,
        },
        password: process.env['TABBY_TEST_PG_PASSWORD'] ?? '',
      });
    }

    win = new BrowserWindow({
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

    const benchWindow = win;
    await benchWindow.loadURL(target);
    await sleep(1500);
    mark(`renderer loaded (liveMode=${String(liveMode)})`);

    /**
     * Drives the real UI: pick the connection, open it, browse the table.
     *
     * Deliberately DOM-level rather than a test hook in the app — a `?bench=live`
     * branch in App.vue would mean the benchmark measures code the shipped app does
     * not run. Vue's v-model listens for `input` and the select for `change`, so
     * dispatching those is enough.
     */
    let liveOpened = false;
    let activeTab = '';
    if (liveMode) {
      liveOpened = (await benchWindow.webContents.executeJavaScript(`(async () => {
      const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const byText = (label) =>
        Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === label,
        );

      const select = document.querySelector('select');
      if (!select) return false;
      select.value = ${JSON.stringify(BENCH_CONNECTION_ID)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await nap(100);

      const open = byText('Open');
      if (!open) return false;
      open.click();
      await nap(2500);

      const table = document.querySelector('[data-browse-input]');
      const browse = byText('Open table');
      if (!table || !browse) return false;
      table.value = ${JSON.stringify(BENCH_TABLE)};
      table.dispatchEvent(new Event('input', { bubbles: true }));
      await nap(100);
      browse.click();
      return true;
    })()`)) as boolean;

      // The query has to run, the tab has to open, and the grid has to remount onto
      // the live source before the bench button means anything.
      await sleep(6000);

      activeTab = (await benchWindow.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role="tab"]'))
         .find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? ''`,
      )) as string;
      mark(`drove the UI: opened=${String(liveOpened)} activeTab="${activeTab.trim()}"`);
    }

    const clicked = (await benchWindow.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const bench = buttons.find((b) => b.textContent.includes('bench'));
    if (!bench) return false;
    bench.click();
    return true;
  })()`)) as boolean;

    if (!clicked) {
      process.stdout.write('FAIL: bench button not found in the toolbar\n');
      clearTimeout(watchdog);
      app.exit(1);
      return;
    }
    mark('bench started; polling for the result');

    const deadline = Date.now() + TIMEOUT_MS;
    let resultJson = '';
    while (Date.now() < deadline) {
      resultJson = (await benchWindow.webContents.executeJavaScript(
        `document.querySelector('[data-bench-json]')?.textContent ?? ''`,
      )) as string;
      if (resultJson.trim() !== '') break;
      await sleep(POLL_MS);
    }
    mark(
      resultJson.trim() === '' ? 'no result before the deadline' : 'result received; tearing down',
    );

    disposeIpc?.();
    if (services) await services.dispose();
    if (settingsDir) rmSync(settingsDir, { recursive: true, force: true });
    mark('torn down');

    if (resultJson.trim() === '') {
      process.stdout.write(`FAIL: bench produced no result within ${TIMEOUT_MS}ms\n`);
      clearTimeout(watchdog);
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
    if (liveMode) {
      // Without this, a bench that silently fell back to the synthetic grid would
      // still report a passing p95 and prove nothing about the live path.
      if (!liveOpened) failures.push('live mode: could not drive the UI to open the table');
      if (!activeTab.includes(BENCH_TABLE)) {
        failures.push(`live mode: the active tab is "${activeTab}", not ${BENCH_TABLE}`);
      }
    }
    failures.push(...errors.map((message) => `console: ${message}`));

    process.stdout.write(
      `${JSON.stringify({ target, liveMode, activeTab, result, errors, failures }, null, 2)}\n`,
    );

    clearTimeout(watchdog);
    app.exit(failures.length > 0 ? 1 : 0);
  })
  .catch((error: unknown) => {
    // Without this, a throw anywhere above leaves Electron running with an open
    // window and no output at all — the harness looks hung rather than failed.
    process.stdout.write(`FAIL: bench harness threw: ${String(error)}\n`);
    if (error instanceof Error && error.stack) process.stdout.write(`${error.stack}\n`);
    app.exit(1);
  });
