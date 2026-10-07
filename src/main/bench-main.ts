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
import { HistoryStore } from './store/history-store';
import type { SecretCipher } from './store/cipher';

const target =
  process.env['TABBY_BENCH_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;

/** 600 frames at 60fps is 10s; allow generous headroom for cold caches and CI. */
const TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const BENCH_CONNECTION_ID = 'bench-live';
const BENCH_TABLE = process.env['TABBY_BENCH_TABLE'] ?? 'fixtures.big';
/**
 * The schema the tree bench expands. `scripts/pg-fixtures.sql` creates it with
 * 2,000 relations, which is PLAN Phase 6's stated scale.
 */
const BENCH_TREE_SCHEMA = process.env['TABBY_BENCH_TREE_SCHEMA'] ?? 'fixtures_many';
const TREE_FRAMES = 600;

/**
 * The tree's frame budget.
 *
 * GRID-SPEC §11 sets 10ms p95 for the grid's canvas paint. The tree is DOM rather
 * than canvas and its per-frame work is a keyed patch of ~22 text rows, so it gets
 * a tighter budget: 8ms leaves room inside one 16.7ms frame for the browser's own
 * style, layout and paint. The fps floor is 55 rather than 60 because a single
 * dropped frame in 600 is not a defect and must not fail the gate.
 */
const TREE_BUDGET_P95_MS = 8;
const TREE_BUDGET_FPS = 55;

interface TreeBench {
  readonly frames: number;
  readonly rowsInTree: number;
  readonly rowsInDom: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly dropped: number;
  readonly sustainedFps: number;
  readonly budgetP95Ms: number;
  readonly budgetFps: number;
  readonly withinBudget: boolean;
  readonly withinFps: boolean;
  readonly virtualised: boolean;
  readonly error: string | null;
}

const EMPTY_TREE_BENCH: TreeBench = {
  frames: 0,
  rowsInTree: 0,
  rowsInDom: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  dropped: 0,
  sustainedFps: 0,
  budgetP95Ms: TREE_BUDGET_P95_MS,
  budgetFps: TREE_BUDGET_FPS,
  withinBudget: false,
  withinFps: false,
  virtualised: false,
  error: null,
};

/**
 * Scrolls the real tree through the real DOM and measures it.
 *
 * Driven from here rather than from a button in the app, because unlike the grid
 * bench there is no user-facing "bench the tree" control to click — and adding one
 * would mean shipping measurement code inside the product. What the renderer does
 * is exactly what a trackpad does: set `scrollTop` on the scroller and let the
 * `scroll` event run. No test hook, no app-side branch.
 *
 * Two numbers come back. The **frame interval** is what the user perceives: an rAF
 * callback only arrives once the previous frame's microtasks, style, layout and
 * paint are done, so an interval over ~16.7ms means a dropped frame. The
 * **in-frame work** is the part Tabby controls — Vue's patch plus a forced layout —
 * measured so a regression from 2ms to 12ms is visible *before* it starts dropping
 * frames.
 */
async function runTreeBench(win: BrowserWindow): Promise<TreeBench> {
  const script = `(async () => {
    const FRAMES = ${TREE_FRAMES};
    const SCHEMA = ${JSON.stringify(BENCH_TREE_SCHEMA)};
    const empty = ${JSON.stringify({ ...EMPTY_TREE_BENCH })};

    const scroller = document.querySelector('[data-tree-scroller]');
    if (!scroller) return { ...empty, error: 'no tree scroller in the DOM' };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const items = () => document.querySelectorAll('[role="treeitem"]');

    // Expand the 2,000-relation schema by clicking its caret, as a user would.
    const row = Array.from(items()).find(
      (element) => element.getAttribute('data-node-label') === SCHEMA,
    );
    if (!row) return { ...empty, error: 'schema ' + SCHEMA + ' is not in the tree' };
    row.querySelector('.caret').click();
    await sleep(2500);

    // Read the count the pane itself reports, so the assertion is about what the
    // user sees rather than about a number this harness computed separately.
    const status = document.querySelector('[data-schema-tree] .status span');
    const rowsInTree = status ? Number((status.textContent || '').replace(/[^0-9]/g, '')) : 0;
    const rowsInDom = items().length;
    // The point of the phase: thousands of relations, a couple of dozen elements.
    const virtualised = rowsInTree > 1000 && rowsInDom > 0 && rowsInDom < 100;
    if (!virtualised) {
      return { ...empty, rowsInTree, rowsInDom, error: 'tree is not virtualised as expected' };
    }

    const slice = document.querySelector('[data-tree-slice]');
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const work = [];
    const intervals = [];
    let previous = null;

    for (let frame = 0; frame < FRAMES; frame += 1) {
      await nextFrame();
      const startedAt = performance.now();
      if (previous !== null) intervals.push(startedAt - previous);
      previous = startedAt;

      // Sweep to the bottom and back, so the window is rebuilt at both ends and in
      // the middle rather than settling into one cached slice.
      const half = FRAMES / 2;
      const progress = frame < half ? frame / half : (FRAMES - frame) / half;
      scroller.scrollTop = progress * maxScroll;
      scroller.dispatchEvent(new Event('scroll'));

      // Vue flushes its job queue in a microtask, so yielding a few times lands
      // after the patch. Reading the box then forces style and layout to happen
      // inside the measurement rather than at some later, unmeasured point.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      if (slice) slice.getBoundingClientRect();
      work.push(performance.now() - startedAt);
    }

    const sorted = [...work].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)] ?? 0;
    const sustainedFps = medianInterval > 0 ? 1000 / medianInterval : 0;
    const p95 = at(0.95);

    return {
      ...empty,
      frames: work.length,
      rowsInTree,
      rowsInDom,
      p50: at(0.5),
      p95,
      p99: at(0.99),
      dropped: intervals.filter((interval) => interval > 25).length,
      sustainedFps,
      withinBudget: p95 < empty.budgetP95Ms,
      withinFps: sustainedFps >= empty.budgetFps,
      virtualised,
      error: null,
    };
  })()`;

  try {
    return (await win.webContents.executeJavaScript(script)) as TreeBench;
  } catch (error) {
    return {
      ...EMPTY_TREE_BENCH,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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
      // A local copy, because `settingsDir` is a module-level `let` and TypeScript
      // cannot narrow it inside the `pickPath` closure below.
      const dir = settingsDir;
      const settings = new SettingsStore({ dir, cipher });
      const history = new HistoryStore({ dir: join(dir, 'history') });
      services = createDbServices({
        settings,
        // The bench never exports, but the dependency is required rather than
        // defaulted so that no entry point can silently get a different one.
        pickPath: async (suggested) => join(dir, 'exports', suggested),
        // Same wiring as `src/main/index.ts`. Without it the renderer never sees a
        // progress event, so the exact row count never replaces the `reltuples`
        // estimate and the benchmark would be measuring a scrollbar that lies.
        emit: (channel, payload) => {
          if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
        },
      });
      disposeIpc = registerIpcHandlers({
        settings,
        window: () => win,
        connections: services.connections,
        schemas: services.schemas,
        queries: services.queries,
        history,
        exports: services.exports,
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
     * Drives the real UI: pick the connection, open it, then browse the table
     * through the schema tree.
     *
     * Deliberately DOM-level rather than a test hook in the app — a `?bench=live`
     * branch in App.vue would mean the benchmark measures code the shipped app does
     * not run. Vue's v-model listens for `input` and the select for `change`, so
     * dispatching those is enough.
     *
     * Phase 7 removed the "browse a table" text box the harness used to type into;
     * the tree is now the way in. That is a better harness, not a worse one — it
     * drives the two gestures a user actually makes (expand a schema, double-click a
     * relation) and it exercises the same browse path, so the grid measurement still
     * covers keyset paging with no transaction held open.
     */
    let liveOpened = false;
    let activeTab = '';
    let treeResult: TreeBench | null = null;
    if (liveMode) {
      const dot = BENCH_TABLE.indexOf('.');
      const benchSchema = dot < 0 ? 'public' : BENCH_TABLE.slice(0, dot);
      const benchRelation = dot < 0 ? BENCH_TABLE : BENCH_TABLE.slice(dot + 1);

      liveOpened = (await benchWindow.webContents.executeJavaScript(`(async () => {
      const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const byText = (label) =>
        Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === label,
        );
      const rowFor = (label) =>
        Array.from(document.querySelectorAll('[role="treeitem"]')).find(
          (element) => element.getAttribute('data-node-label') === label,
        );
      /** Polls rather than sleeping a fixed guess: the catalog read is I/O. */
      const waitFor = async (find, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const found = find();
          if (found) return found;
          if (Date.now() > deadline) return null;
          await nap(50);
        }
      };

      const select = document.querySelector('select');
      if (!select) return false;
      select.value = ${JSON.stringify(BENCH_CONNECTION_ID)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await nap(100);

      const open = byText('Open');
      if (!open) return false;
      open.click();

      const schemaRow = await waitFor(() => rowFor(${JSON.stringify(benchSchema)}), 15000);
      if (!schemaRow) return false;
      schemaRow.querySelector('.caret').click();

      const tableRow = await waitFor(() => rowFor(${JSON.stringify(benchRelation)}), 15000);
      if (!tableRow) return false;
      tableRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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

      // Measured before the grid bench so the two do not compete for frames, and
      // after the 6s settle so the tree has finished its catalog read.
      treeResult = await runTreeBench(benchWindow);
      mark(
        `tree: ${treeResult.rowsInTree} rows in the tree, ${treeResult.rowsInDom} in the DOM, ` +
          `p95 ${treeResult.p95.toFixed(2)}ms, ${treeResult.sustainedFps.toFixed(1)}fps` +
          (treeResult.error === null ? '' : `, error: ${treeResult.error}`),
      );
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

      // Phase 6's exit criterion, as a gate rather than an impression.
      const tree = treeResult;
      if (tree === null) {
        failures.push('live mode: the tree bench never ran');
      } else {
        if (tree.error !== null) failures.push(`tree: ${tree.error}`);
        if (!tree.virtualised) {
          failures.push(
            `tree: ${tree.rowsInTree} rows in the tree but ${tree.rowsInDom} in the DOM — ` +
              'the window is not doing its job',
          );
        }
        if (tree.frames < 100) {
          failures.push(`tree: only ${tree.frames} frames recorded; expected at least 100`);
        }
        if (!tree.withinBudget) {
          failures.push(
            `tree: p95 in-frame work ${tree.p95.toFixed(2)}ms exceeds the ${tree.budgetP95Ms}ms budget`,
          );
        }
        if (!tree.withinFps) {
          failures.push(
            `tree: ${tree.sustainedFps.toFixed(1)}fps sustained is below the ${tree.budgetFps}fps floor`,
          );
        }
      }
    }
    failures.push(...errors.map((message) => `console: ${message}`));

    process.stdout.write(
      `${JSON.stringify({ target, liveMode, activeTab, result, tree: treeResult, errors, failures }, null, 2)}\n`,
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
