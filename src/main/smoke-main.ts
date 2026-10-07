/**
 * Headless smoke harness. This is a real Electron main entry built by the same
 * pipeline as the app, and it calls the SAME applySecurityGuards() the app does
 * — so it exercises production security code rather than a copy of it.
 *
 *   npm run smoke                       # built renderer + prod CSP
 *   TABBY_SMOKE_CSP=dev npm run smoke   # dev policy
 *   TABBY_SMOKE_URL=http://localhost:5173/ npm run smoke
 *
 * Exits non-zero on any failed assertion or unexpected console error.
 */
import { app, BrowserWindow, clipboard } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySecurityGuards, type CspProfile } from './security/navigation';
import { registerIpcHandlers } from './ipc/router';
import { createDbServices } from './db/services';
import { SettingsStore } from './store/settings-store';
import { HistoryStore } from './store/history-store';
import type { SecretCipher } from './store/cipher';

const defaultUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
const target = process.env['TABBY_SMOKE_URL'] ?? defaultUrl;
const profile: CspProfile = process.env['TABBY_SMOKE_CSP'] === 'dev' ? 'dev' : 'prod';

/**
 * Whether the live sections run, decided once at module scope.
 *
 * Read here rather than further down because the watchdog budget depends on it, and
 * the watchdog is installed before the rest of the harness has worked that out.
 */
const LIVE_CONFIGURED =
  (process.env['TABBY_TEST_PG_USER'] ?? '') !== '' &&
  (process.env['TABBY_TEST_PG_DATABASE'] ?? '') !== '';

/**
 * Hard ceiling so a stalled renderer fails the harness instead of hanging CI.
 *
 * Longer with a database: the live sections run real queries, a 200k-row export and
 * a cancelled 10M-row export against the server, and none of those has a fixed cost
 * on a shared runner. The database-free budget stays tight, because that is the run
 * CI performs on every commit and a stall there should be loud rather than patient.
 */
const WATCHDOG_MS = LIVE_CONFIGURED ? 300_000 : 90_000;

const problems: string[] = [];
const cspEnforcement: string[] = [];

/** Console noise Electron itself emits in dev; documented and expected. */
const KNOWN_DEV_WARNING = 'Electron Security Warning';
/**
 * Proof the policy is actively enforced, not a defect. Both wordings are kept
 * because Chromium changed the phrasing (152 uses "Executing inline script
 * violates…", older builds use "Refused to execute inline script…").
 */
const CSP_PROBE_PATTERNS = [
  /Refused to execute inline script/,
  /Executing inline script violates/,
  /Refused to evaluate a string/,
  /Evaluating a string as JavaScript violates/,
];

function classifyConsole(message: string): void {
  if (CSP_PROBE_PATTERNS.some((re) => re.test(message))) {
    cspEnforcement.push(message.slice(0, 120));
    return;
  }
  if (profile === 'dev' && message.includes(KNOWN_DEV_WARNING)) return;
  problems.push(message.slice(0, 300));
}

/**
 * Turn a crash into output.
 *
 * Without these, a rejection inside the harness — a `null.querySelector` because an
 * element was missing, say — leaves Electron running with no window logic left to
 * exit, and the run produces *nothing*: no JSON, no failure, just a process that
 * sits until something external kills it. That is the worst possible outcome for a
 * harness whose whole job is to report. Found by watching a live run do exactly
 * that for ten minutes.
 */
function die(kind: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stdout.write(`${JSON.stringify({ fatal: kind, message: message.slice(0, 2000) })}\n`);
  app.exit(1);
}

process.on('unhandledRejection', (reason: unknown) => die('unhandledRejection', reason));
process.on('uncaughtException', (error: unknown) => die('uncaughtException', error));

app
  .whenReady()
  .then(async () => {
    applySecurityGuards(profile);

    // Real router against a throwaway settings dir, so the IPC round-trip under
    // test is the production code path rather than a stub.
    const settingsDir = mkdtempSync(join(tmpdir(), 'tabby-smoke-'));
    const cipher: SecretCipher = {
      available: true,
      encrypt: (plain) => `enc(${Buffer.from(plain, 'utf8').toString('base64')})`,
      decrypt: (ct) => Buffer.from(ct.slice(4, -1), 'base64').toString('utf8'),
    };
    const settings = new SettingsStore({ dir: settingsDir, cipher });
    const historyStore = new HistoryStore({ dir: join(settingsDir, 'history') });
    const exportDir = join(settingsDir, 'exports');
    mkdirSync(exportDir, { recursive: true });
    /**
     * Every destination the fake picker handed out, in order.
     *
     * Recorded rather than guessed from the file name: two exports in one run both
     * suggest `export.csv`, and a collision would make the second silently overwrite
     * the first — after which "the file has the right number of rows" would be an
     * assertion about whichever export happened to land last.
     */
    const exportedPaths: string[] = [];

    // Watchdog: a stalled executeJavaScript must fail loudly, not hang CI forever.
    const watchdog = setTimeout(() => {
      process.stdout.write(`FAIL: smoke harness exceeded ${WATCHDOG_MS}ms\n`);
      app.exit(1);
    }, WATCHDOG_MS);
    watchdog.unref?.();

    const win = new BrowserWindow({
      // Shown and focused on purpose: Chromium rejects `navigator.clipboard`
      // writes from an unfocused document, so a hidden window cannot exercise the
      // copy path at all. The window is closed again before exit.
      show: true,
      width: 1440,
      height: 900,
      backgroundColor: '#030b16',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Required: a backgrounded window gets its timers and rAF intensively
        // throttled, which stalls the interaction script's awaits indefinitely.
        backgroundThrottling: false,
      },
    });

    // Rest-args form: Electron is migrating console-message from positional
    // arguments to an Event object, and both shapes are live in 44.x.
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
      if (level >= 2) classifyConsole(message);
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      problems.push(`preload ${preloadPath}: ${error?.message ?? String(error)}`);
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      problems.push(`load failed ${code}: ${description}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      problems.push(`renderer gone: ${details.reason}`);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // The same object graph the real app builds, so the harness cannot pass on a
    // wiring the shipped binary does not use.
    //
    // `emit` forwards to the window exactly as `src/main/index.ts` does. It used to
    // be a no-op here on the reasoning that "the harness polls" — which was true
    // until Phase 7, where the Cancel button's only source of the in-flight result
    // id is the `planning` progress event. With `emit` dropped, the harness was
    // measuring a renderer that could never receive an eviction, a connection-lost
    // or a progress notice: three code paths shipping untested. Wiring it makes the
    // harness match production instead of a simpler thing that passes.
    const db = createDbServices({
      settings,
      // No native dialog can be driven headlessly, so the harness supplies the
      // destination itself. It stays inside the throwaway settings dir, which means
      // the export assertions can read the bytes back — the same non-circular trick
      // the settings ciphertext check uses.
      pickPath: async (suggested) => {
        const path = join(exportDir, `${exportedPaths.length}-${suggested}`);
        exportedPaths.push(path);
        return path;
      },
      emit: (channel, payload) => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
    });
    const disposeIpc = registerIpcHandlers({
      settings,
      window: () => win,
      connections: db.connections,
      schemas: db.schemas,
      queries: db.queries,
      history: historyStore,
      exports: db.exports,
    });

    await win.loadURL(target);
    // The document must hold focus or Chromium rejects clipboard writes.
    win.show();
    win.focus();
    win.webContents.focus();
    // Let the render loop paint enough frames that the data window has resolved.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const report = (await win.webContents.executeJavaScript(`(() => {
    let evalBlocked = false;
    try { (0, eval)('1 + 1'); } catch { evalBlocked = true; }

    let inlineScriptBlocked = false;
    try {
      const s = document.createElement('script');
      s.textContent = 'window.__tabbyCspProbe = 1;';
      document.head.appendChild(s);
      inlineScriptBlocked = window.__tabbyCspProbe === undefined;
    } catch { inlineScriptBlocked = true; }

    // Five stacked canvases; the body layer is first in document order.
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const body = canvases[0] ?? null;

    // Prove pixels were actually drawn, not merely that a canvas exists.
    // Sampled sparsely: reading a full HiDPI backing store is slow.
    let distinctColors = 0;
    if (body && body.width > 0 && body.height > 0) {
      const probe = body.getContext('2d');
      if (probe) {
        const data = probe.getImageData(0, 0, body.width, body.height).data;
        const seen = new Set();
        for (let i = 0; i < data.length; i += 4 * 997) {
          seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
        }
        distinctColors = seen.size;
      }
    }

    return {
      title: document.title,
      bridgeType: typeof window.tabby,
      versions: window.tabby ? window.tabby.versions : null,
      requireLeaked: typeof window.require !== 'undefined',
      processLeaked: typeof window.process !== 'undefined',
      bufferLeaked: typeof window.Buffer !== 'undefined',
      canvasCount: canvases.length,
      canvasesSized: canvases.every((c) => c.width > 0 && c.height > 0),
      distinctColors,
      buttons: document.querySelectorAll('button').length,
      footerText: document.querySelector('footer') ? document.querySelector('footer').innerText : '',
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      evalBlocked,
      inlineScriptBlocked,
    };
  })()`)) as Record<string, unknown>;

    const strict = profile === 'prod';

    // ── End-to-end interaction ─────────────────────────────────────────────────
    // Drives the real grid with real DOM events and reads the status bar, which is
    // fed by onSelectionChange -> Vue. That makes this a full round-trip check:
    // event -> reducer -> callback -> framework -> DOM.
    const interaction = (await win.webContents.executeJavaScript(`(async () => {
    const root = document.querySelector('.grid-root');
    const footer = document.querySelector('footer span');
    if (!root || !footer) return { error: 'grid or footer not found' };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => (footer.textContent || '').trim();

    root.focus();
    const press = async (key, mods) => {
      root.dispatchEvent(new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true,
        shiftKey: !!(mods && mods.shift),
        metaKey: !!(mods && mods.meta),
        ctrlKey: !!(mods && mods.ctrl),
        altKey: false,
      }));
      await sleep(30);
    };

    const steps = {};
    await press('Escape');
    steps.afterEscape = read();

    await press('ArrowDown');
    steps.afterArrowDown = read();

    await press('ArrowRight');
    steps.afterArrowRight = read();

    // Build a 4x3 block: shift+Down x3, shift+Right x2 from the current cell.
    for (let i = 0; i < 3; i += 1) await press('ArrowDown', { shift: true });
    for (let i = 0; i < 2; i += 1) await press('ArrowRight', { shift: true });
    steps.afterBlock = read();

    await press('End', { meta: true });
    steps.afterCmdEnd = read();

    await press('Home', { meta: true });
    steps.afterCmdHome = read();

    await press('PageDown');
    steps.afterPageDown = read();

    // Copy the block: rebuild it, then cmd+C.
    await press('Escape');
    for (let i = 0; i < 3; i += 1) await press('ArrowDown', { shift: true });
    for (let i = 0; i < 2; i += 1) await press('ArrowRight', { shift: true });
    steps.beforeCopy = read();

    // Instrument the real clipboard call so a silent failure is visible: was
    // writeText called at all, with what length, and did it reject?
    window.__clipCalls = [];
    window.__rejections = [];
    window.addEventListener('unhandledrejection', (e) => {
      window.__rejections.push(String(e.reason));
    });
    const originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text) => {
      // Capture the payload regardless of whether the write is permitted, so the
      // serialisation can be asserted even without user activation.
      window.__clipCalls.push({ text });
      try {
        const result = await originalWrite(text);
        window.__clipResult = { ok: true };
        return result;
      } catch (e) {
        window.__clipResult = { ok: false, error: String(e) };
        throw e;
      }
    };

    await press('c', { meta: true });
    await sleep(600);
    steps.clipCalls = JSON.stringify(window.__clipCalls.map((c) => c.text.length));
    steps.clipPayload = window.__clipCalls.length > 0 ? window.__clipCalls[0].text : '';
    steps.clipResult = JSON.stringify(window.__clipResult ?? null);
    steps.rejections = JSON.stringify(window.__rejections);
    // Chromium gates clipboard writes on transient user activation, which a
    // synthetic (untrusted) dispatchEvent cannot provide. Record it so the
    // harness can tell "broken copy" from "untestable with synthetic events".
    steps.userActivation = JSON.stringify({
      isActive: navigator.userActivation ? navigator.userActivation.isActive : null,
      hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
    });

    // Report clipboard availability without writing, so the probe cannot
    // overwrite what the grid just copied.
    steps.clipboardProbe = JSON.stringify({
      isSecureContext: window.isSecureContext,
      hasWriteText: typeof (navigator.clipboard && navigator.clipboard.writeText) === 'function',
      documentHasFocus: document.hasFocus(),
    });
    await sleep(200);

    // Accessibility: the proxy grid must carry true totals and absolute indices.
    const grid = document.querySelector('[role="grid"]');
    const dataRows = Array.from(document.querySelectorAll('[role="row"][data-kind="data"]'));
    const live = document.querySelector('[role="status"]');
    const aria = grid ? {
      rowCount: grid.getAttribute('aria-rowcount'),
      colCount: grid.getAttribute('aria-colcount'),
      label: grid.getAttribute('aria-label'),
      mirroredRows: dataRows.length,
      firstRowIndex: dataRows[0] ? dataRows[0].getAttribute('aria-rowindex') : null,
      cellsInFirstRow: dataRows[0] ? dataRows[0].querySelectorAll('[role="gridcell"]').length : 0,
      selectedCells: document.querySelectorAll('[role="gridcell"][aria-selected="true"]').length,
      liveText: live ? (live.textContent || '') : '',
    } : null;

    return { steps, aria };
  })()`)) as {
      error?: string;
      steps: Record<string, string>;
      aria: Record<string, unknown> | null;
    };

    if (interaction.error) problems.push(`interaction: ${interaction.error}`);

    // ── Schema explorer (Phase 6) ────────────────────────────────────────────
    // Database-free on purpose: what this proves is that the new sidebar mounts
    // under the **production CSP** and renders its empty states rather than
    // throwing into a render. A component that only works with a database attached
    // would take the whole window down for every user until they connected.
    const tree = (await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('[data-schema-tree]');
    const detail = document.querySelector('[data-table-detail]');
    return {
      panePresent: !!pane,
      treeRoles: document.querySelectorAll('[role="tree"]').length,
      treeitems: document.querySelectorAll('[role="treeitem"]').length,
      emptyState: pane ? (pane.textContent || '').includes('Open a connection') : false,
      filterPresent: !!document.querySelector('[data-tree-filter]'),
      refreshPresent: !!document.querySelector('[data-tree-refresh]'),
      detailPresent: !!detail,
      detailInvites: detail
        ? (detail.textContent || '').includes('Select a table, view or materialized view')
        : false,
      // No connection is open, so nothing may have been fetched or rendered.
      scrollerPresent: !!document.querySelector('[data-tree-scroller]'),
    };
  })()`)) as Record<string, unknown>;

    // ── Query editor (Phase 7) ───────────────────────────────────────────────
    // Types real SQL into the real textarea under the production CSP and reads back
    // what the highlight layer did with it.
    //
    // Two things only this harness can settle. First, that `v-html` on the
    // highlight layer does not become an injection vector in the shipped renderer:
    // the escaping is unit-tested, but the unit test runs in happy-dom, not in
    // Chromium with the prod policy. Second, that the lexer-aware splitter agrees
    // with main's `assertSingleStatement` *in the app* — a semicolon inside a
    // string, a comment or a `$$` body must not become a statement boundary, or the
    // editor would send a fragment main then refuses.
    const editor = (await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pane = document.querySelector('[data-query-editor]');
    const area = document.querySelector('[data-sql-input]');
    if (!pane || !area) return { present: false };

    const pre = () => document.querySelector('[data-highlight]');
    const count = () => {
      const meta = pane.querySelector('[data-statement-count]');
      return meta ? Number(meta.getAttribute('data-statement-count')) : -1;
    };
    const type = async (text) => {
      area.value = text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
    };

    const out = { present: true };

    out.hasHighlightLayer = !!pre();
    out.hasGutter = !!pane.querySelector('.gutter');
    out.hasCurrentLine = !!pane.querySelector('.current-line');

    const source = "select 'a;b' from t";
    await type(source);
    out.statementCount = count();
    out.spanCount = pre().querySelectorAll('span').length;
    // The highlight layer must contain exactly the source characters, or the caret
    // visibly separates from the text it is supposed to sit on.
    out.renderedText = pre().textContent;
    out.textMatchesSource = pre().textContent === source;
    out.hasKeywordSpan = !!pre().querySelector('.tok-keyword');
    out.hasStringSpan = !!pre().querySelector('.tok-string');

    // A semicolon in a string, a line comment and a dollar body: one statement each.
    await type('select 1; -- a ; in a comment');
    out.commentDoesNotSplit = count() === 1;
    await type('select $$ a ; b $$');
    out.dollarDoesNotSplit = count() === 1;
    await type("select E'a\\\\';b'");
    out.escapeStringDoesNotSplit = count() === 1;
    await type('select 1; select 2;');
    out.realSeparatorSplits = count() === 2;

    // Injection: the source is HTML-looking text, and must stay text.
    await type('<img src=x onerror="alert(1)">');
    out.injectedElements = pre().querySelectorAll('img').length;
    out.escapedAngle = pre().innerHTML.includes('&lt;');

    // Unterminated input is the normal state of an editor: report it, do not throw.
    await type("select 'abc");
    out.unterminatedReported = !!pane.querySelector('[data-lex-error]');
    out.unterminatedStillHighlighted = pre().querySelectorAll('span').length > 0;

    // CRLF, checked against the textarea rather than against a literal: the
    // invariant is that the two layers agree, whatever the DOM does to either.
    // Chromium's HTML parser normalizes a bare \\r in parsed content away, which
    // happy-dom does not — so this is the only place the escaping is really proved.
    await type('select 1\\r\\nfrom t');
    out.crlfTextMatches = pre().textContent === area.value;
    out.crlfRenderedLength = pre().textContent.length;
    out.crlfSourceLength = area.value.length;

    await type('');
    out.runPresent = !!pane.querySelector('[data-run]');
    out.runAllPresent = !!pane.querySelector('[data-run-all]');
    out.explainPresent = !!pane.querySelector('[data-explain]');
    const cancel = pane.querySelector('[data-cancel]');
    out.cancelPresent = !!cancel;
    // Nothing is running, so Cancel must be inert rather than clickable.
    out.cancelDisabled = cancel ? cancel.disabled : false;
    out.runDisabled = pane.querySelector('[data-run]').disabled;
    return out;
  })()`)) as Record<string, unknown>;

    // ── Query history (Phase 7) ──────────────────────────────────────────────
    // Drives the real bridge and the real panel: record, list, delete, filter,
    // restore into the editor, and refuse five hostile payloads.
    //
    // It deliberately leaves its records on disk. Main then reads the JSONL file
    // itself, which is the only non-circular proof that the log is real bytes in a
    // real directory — a renderer cannot attest to its own persistence — and the
    // follow-up `historyClear` block proves "clear history" removes those bytes
    // rather than hiding them. PLAN's privacy note asks for exactly that action.
    const history = (await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = {};
    const db = window.tabby && window.tabby.db;
    out.hasBridge = !!db &&
      typeof db.historyList === 'function' && typeof db.historyAdd === 'function' &&
      typeof db.historyDelete === 'function' && typeof db.historyClear === 'function';
    if (!db) return out;

    await db.historyClear();

    const record = (sql, status) => db.historyAdd({
      sql,
      connectionId: 'smoke-1',
      connectionLabel: 'Smoke · db.internal:5432/app',
      status,
      elapsedMs: 7,
      rowCount: 3,
    });

    const first = await record('select 1', 'ok');
    out.addOk = first.ok === true;
    // id and ranAt are main's to generate; a renderer that could supply them could
    // backdate or collide records.
    out.addCarriesMainId = first.ok === true && typeof first.value.id === 'string' &&
      first.value.id.length > 0;
    out.addCarriesMainTimestamp = first.ok === true && Number.isFinite(first.value.ranAt);
    out.addEchoesTheStatement = first.ok === true && first.value.sql === 'select 1';

    await record('select * from fixtures.big', 'ok');
    const failed = await record('select nope from nowhere', 'failed');

    const listed = await db.historyList();
    out.listOk = listed.ok === true;
    out.listCount = listed.ok === true ? listed.value.entries.length : -1;
    out.listNewestFirst = listed.ok === true &&
      listed.value.entries[0].sql === 'select nope from nowhere';
    out.listCarriesStatus = listed.ok === true && listed.value.entries[0].status === 'failed';
    out.listCarriesLabel = listed.ok === true &&
      listed.value.entries[0].connectionLabel === 'Smoke · db.internal:5432/app';
    out.listSkippedNothing = listed.ok === true && listed.value.skipped === 0;

    // The id main handed back is the one a delete names.
    const failedId = failed.ok === true ? failed.value.id : '';
    out.deleteOk = (await db.historyDelete(failedId)).ok === true;
    const afterDelete = await db.historyList();
    out.countAfterDelete = afterDelete.ok === true ? afterDelete.value.entries.length : -1;
    out.deleteTwiceIsNotFound = (await db.historyDelete(failedId)).ok === false;

    const limited = await db.historyList(1);
    out.limitHonoured = limited.ok === true && limited.value.entries.length === 1;

    // Hostile payloads. Each must be refused with a tagged error and must not have
    // written anything, which the count after them is what proves.
    const base = {
      sql: 'select 1', connectionId: 'smoke-1', connectionLabel: '',
      status: 'ok', elapsedMs: 1, rowCount: 1,
    };
    const nul = String.fromCharCode(0);
    const hostile = [
      ['a smuggled id', Object.assign({}, base, { id: 'mine' })],
      ['a smuggled timestamp', Object.assign({}, base, { ranAt: 1 })],
      ['a NUL in the statement', Object.assign({}, base, { sql: 'select ' + nul + '1' })],
      ['an invented status', Object.assign({}, base, { status: 'exploded' })],
      ['a non-object payload', 'select 1'],
    ];
    out.hostileRejected = 0;
    out.hostileThrew = 0;
    for (const [, payload] of hostile) {
      try {
        const result = await db.historyAdd(payload);
        if (result.ok === false && result.error.code === 'VALIDATION_FAILED') out.hostileRejected += 1;
      } catch {
        out.hostileThrew += 1;
      }
    }
    out.hostileTotal = hostile.length;
    out.limitBeyondCapRefused = (await db.historyList(100000000)).ok === false;
    const afterHostile = await db.historyList();
    out.countUnchangedByHostile = afterHostile.ok === true && afterHostile.value.entries.length === 2;

    // ── The panel, driven by the buttons a user would press ──────────────────
    await record('select * from fixtures.wide order by id', 'ok');

    const panel = () => document.querySelector('[data-history-panel]');
    const toggle = document.querySelector('[data-history-toggle]');
    out.togglePresent = !!toggle;
    if (toggle) toggle.click();
    await sleep(250);

    out.panelOpened = !!panel();
    out.panelIsDialog = !!panel() && panel().getAttribute('role') === 'dialog';
    out.panelIsLabelled = !!panel() && panel().getAttribute('aria-label') === 'Query history';
    out.rowsRendered = panel() ? panel().querySelectorAll('[data-history-item]').length : -1;
    // The privacy note is rendered where the secrets are listed, not only in PLAN.
    out.privacyNoteShown = !!panel() && panel().textContent.includes('never synced');

    const search = panel() ? panel().querySelector('[data-history-search]') : null;
    out.searchPresent = !!search;
    if (search) {
      search.value = 'fixtures.wide';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      out.filterNarrowsToOne = panel().querySelectorAll('[data-history-item]').length === 1;
    }

    // Restoring must hand the editor the statement, not the one-line preview.
    const row = panel() ? panel().querySelector('[data-history-load]') : null;
    out.rowFound = !!row;
    if (row) row.click();
    await sleep(250);
    const area = document.querySelector('[data-sql-input]');
    out.editorReceivedStatement = !!area &&
      area.value === 'select * from fixtures.wide order by id';
    out.panelClosedAfterLoad = !document.querySelector('[data-history-panel]');

    // Escape closes, and takes the document listener with it.
    if (toggle) toggle.click();
    await sleep(200);
    out.reopened = !!panel();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    out.escapeClosed = !document.querySelector('[data-history-panel]');

    return out;
  })()`)) as Record<string, unknown>;

    // Main reads the log back itself. A renderer cannot prove its own persistence,
    // and this is the assertion that the file is where the privacy note says it is:
    // inside userData, in its own directory, and nowhere else.
    const historyDir = join(settingsDir, 'history');
    const historyOnDisk = existsSync(historyDir)
      ? readdirSync(historyDir).filter((name) => name.endsWith('.jsonl'))
      : [];
    const historyText = existsSync(join(historyDir, 'history.jsonl'))
      ? readFileSync(join(historyDir, 'history.jsonl'), 'utf8')
      : '';
    const historyLines = historyText.split('\n').filter((line) => line.trim() !== '');
    const escapedOutsideHistoryDir = readdirSync(settingsDir).filter((name) =>
      name.endsWith('.jsonl'),
    );

    // "Clear history" through the panel, then main checks the bytes are gone. The
    // renderer reporting an empty list would also be what a bug that merely hides
    // the rows reports, so the filesystem is the witness.
    const historyCleared = (await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = {};
    const panel = () => document.querySelector('[data-history-panel]');
    const clearButton = () => panel() && panel().querySelector('[data-history-clear]');

    const toggle = document.querySelector('[data-history-toggle]');
    if (toggle) toggle.click();
    await sleep(250);
    out.reopenedWithRows = panel() ? panel().querySelectorAll('[data-history-item]').length : -1;
    // The filter typed in the previous block must not survive the close: reopening
    // narrowed to it would look like the log had lost entries.
    const reopenedSearch = panel() ? panel().querySelector('[data-history-search]') : null;
    out.filterResetOnReopen = !!reopenedSearch && reopenedSearch.value === '';

    const armed = clearButton();
    out.clearPresent = !!armed;
    if (armed) armed.click();
    await sleep(150);
    // One click only arms the action: a stray click must not destroy the log.
    out.firstClickOnlyArms =
      !!panel() && panel().querySelectorAll('[data-history-item]').length > 0;
    const relabelled = clearButton();
    out.armedLabelChanged = !!relabelled && relabelled.textContent.includes('Click again');

    const confirmed = clearButton();
    if (confirmed) confirmed.click();
    await sleep(300);
    out.emptyStateShown = !!panel() && !!panel().querySelector('[data-history-empty]');

    const listed = await window.tabby.db.historyList();
    out.countAfterClear = listed.ok === true ? listed.value.entries.length : -1;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(120);
    out.closedAtEnd = !document.querySelector('[data-history-panel]');
    return out;
  })()`)) as Record<string, unknown>;

    const historyFilesAfterClear = existsSync(historyDir)
      ? readdirSync(historyDir).filter((name) => name.endsWith('.jsonl'))
      : [];

    // ── Command palette and theme (Phase 8) ──────────────────────────────────
    // Database-free on purpose: neither needs a result, and a check that only runs
    // when TABBY_TEST_PG_* is set is a check CI never performs.
    //
    // The palette query is untrusted keystroke-by-keystroke input fed to a matcher,
    // so the regex-metacharacter case is asserted here rather than assumed: a
    // matcher that built a RegExp from the query would hang the renderer, and a
    // hung renderer is a watchdog kill that looks like an unrelated timeout.
    const chrome = (await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = {};
    const root = document.documentElement;
    const palette = () => document.querySelector('[data-command-palette]');
    const rows = () => palette() ? palette().querySelectorAll('[data-palette-row]') : [];

    // ── theme ────────────────────────────────────────────────────────────────
    out.themeBefore = root.dataset.theme || 'dark';
    // Computed style, not the attribute: setting \`data-theme\` proves the store ran,
    // and nothing more. The CSS block could have been shaken out of the bundle by
    // Tailwind and the attribute would still flip, leaving a UI that says "light"
    // while every surface stays dark.
    const background = () => getComputedStyle(document.body).backgroundColor;
    out.backgroundBefore = background();
    const themeButton = document.querySelector('[data-theme-toggle]');
    out.themeTogglePresent = !!themeButton;
    themeButton.click();
    await sleep(250);
    out.themeAfter = root.dataset.theme;
    out.themeFlipped = out.themeAfter !== out.themeBefore;
    out.backgroundAfter = background();
    out.themeActuallyRepainted = out.backgroundBefore !== out.backgroundAfter;
    const settings = await window.tabby.db.getSettings();
    out.themePersisted = settings.ok ? settings.value.theme : null;
    out.themeMatchesSetting = out.themePersisted === out.themeAfter;
    themeButton.click();
    await sleep(250);
    out.themeRestored = root.dataset.theme === out.themeBefore;
    out.backgroundRestored = background() === out.backgroundBefore;

    // ── palette ──────────────────────────────────────────────────────────────
    const openButton = document.querySelector('[data-palette-open]');
    out.paletteButtonPresent = !!openButton;
    out.exportDisabledWithNoResult =
      document.querySelector('[data-export-open]').disabled === true;
    openButton.click();
    await sleep(250);
    out.paletteOpened = !!palette();
    out.paletteIsDialog = !!palette() && palette().getAttribute('role') === 'dialog';
    out.paletteHasInput = !!palette() && !!palette().querySelector('[data-palette-input]');
    out.paletteListsCommands = rows().length;
    // The filtering property, and the one worth pinning: a command that cannot run
    // is not listed at all. A palette full of inert rows teaches the user that it
    // lies, which is worse than a short list.
    out.noQueryCommandWithoutConnection =
      !Array.from(rows()).some((r) => /Run statement|Run all|Explain/.test(r.textContent));
    out.noResultCommandWithoutResult =
      !Array.from(rows()).some((r) => /Export result|Copy selection/.test(r.textContent));

    const input = palette().querySelector('[data-palette-input]');
    const type = async (text) => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
    };

    // 'thm' is not a substring of 'Theme', so this only passes on a subsequence
    // match — the property that makes a palette usable at typing speed.
    await type('thm');
    out.fuzzyMatched = rows().length > 0;
    out.fuzzyTopIsTheme = rows().length > 0 && /Theme/.test(rows()[0].textContent);
    out.matchedLettersHighlighted = !!palette().querySelector('mark.hit');

    await type('zzzzqqq');
    out.noMatchSaysSo = !!palette().querySelector('[data-palette-empty]');

    await type('(((((((((a');
    out.metacharacterQuerySurvived = !!palette();

    // Enter runs the top command. With no connection open the only Query command
    // is history, so the observable effect is the history panel appearing.
    await type('hist');
    const historyFirst = rows().length > 0 && /Query history/.test(rows()[0].textContent);
    out.enterRunsTopCommand = false;
    if (historyFirst) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(300);
      out.enterRunsTopCommand =
        !document.querySelector('[data-command-palette]') &&
        !!document.querySelector('[data-history-panel]');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);
    }
    out.historyClosedAgain = !document.querySelector('[data-history-panel]');

    // Escape closes, and ⌘K reopens from anywhere in the document.
    openButton.click();
    await sleep(200);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(200);
    out.escapeClosedPalette = !palette();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await sleep(250);
    out.cmdKReopened = !!palette();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(200);
    out.closedAtEnd = !palette();

    return out;
  })()`)) as Record<string, unknown>;

    // ── IPC round-trip ─────────────────────────────────────────────────────────
    // Exercises the production path end to end: renderer -> contextBridge ->
    // ipcMain -> validator -> SettingsStore -> Result back. Also proves a hostile
    // payload is rejected rather than acted on, and that no channel throws.
    const ipc = (await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    const db = window.tabby && window.tabby.db;
    out.hasDb = !!db;
    out.hasEvents = !!(window.tabby && window.tabby.events);
    out.ipcRendererLeaked = typeof window.ipcRenderer !== 'undefined';
    out.requireLeakedAgain = typeof window.require !== 'undefined';
    out.frozen = Object.isFrozen(window.tabby);

    if (!db) return out;

    const settings = await db.getSettings();
    out.settingsOk = settings.ok === true;
    out.theme = settings.ok ? settings.value.theme : null;
    out.connectionsAtStart = settings.ok ? settings.value.connections.length : -1;

    // A validated write that must persist.
    const patched = await db.patchSettings({ theme: 'light' });
    out.patchOk = patched.ok === true;
    out.themeAfterPatch = patched.ok ? patched.value.theme : null;
    const reread = await db.getSettings();
    out.themePersisted = reread.ok ? reread.value.theme : null;

    // Save a connection with a password; the summary must not carry it.
    const saved = await db.saveConnection({
      connection: {
        id: 'smoke-1', name: 'Smoke', host: 'db.internal', port: 5432,
        database: 'app', user: 'reader', sslMode: 'verify-full',
        createdAt: 1700000000000, updatedAt: 1700000000000,
      },
      password: 'sup3r-s3cret-do-not-log',
    });
    out.saveOk = saved.ok === true;
    out.summaryKeys = saved.ok ? Object.keys(saved.value).sort() : [];
    out.summaryLeaksSecret = saved.ok
      ? JSON.stringify(saved.value).includes('sup3r-s3cret-do-not-log')
      : null;

    const listed = await db.listConnections();
    out.listCount = listed.ok ? listed.value.length : -1;
    out.listLeaksSecret = listed.ok
      ? JSON.stringify(listed.value).includes('sup3r-s3cret-do-not-log')
      : null;
    out.listLeaksCiphertext = listed.ok ? JSON.stringify(listed.value).includes('enc(') : null;

    // Hostile payloads: each must come back as a tagged VALIDATION_FAILED,
    // never a thrown error and never a partial success.
    const hostile = [
      ['wrongType', db.resultWindow({ resultId: 'r', startRow: 'zero', rowCount: 10 })],
      ['unknownKey', db.resultWindow({ resultId: 'r', startRow: 0, rowCount: 10, isAdmin: true })],
      ['negativeRow', db.resultWindow({ resultId: 'r', startRow: -1, rowCount: 10 })],
      ['hugeWindow', db.resultWindow({ resultId: 'r', startRow: 0, rowCount: 100000000 })],
      ['nulInSql', db.queryRun({ connectionId: 'c', sql: 'SELECT 1;\\u0000DROP TABLE t' })],
      ['badEnum', db.patchSettings({ theme: 'solarised' })],
      ['protoPollution', db.patchSettings(JSON.parse('{"theme":"dark","__proto__":{"x":1}}'))],
      ['notAnObject', db.patchSettings('nonsense')],
    ];
    out.hostile = {};
    for (const [name, promise] of hostile) {
      try {
        const res = await promise;
        out.hostile[name] = res.ok === false ? (res.error.code || 'untagged') : 'ACCEPTED';
      } catch (e) {
        out.hostile[name] = 'THREW:' + String(e).slice(0, 60);
      }
    }
    out.protoPolluted = ({}).x !== undefined;

    // Channels with nothing behind them must still answer with a typed error and
    // never throw: the harness runs with no database, so every Phase 4 handler is
    // reachable here and has to fail cleanly rather than reject across the bridge.
    const unknownResult = await db.queryCancel('r1');
    out.unknownResultCode = unknownResult.ok === false ? unknownResult.error.code : 'ACCEPTED';

    const unknownConnection = await db.schemaChildren({ connectionId: 'nope', parentSchema: null });
    out.unknownConnectionCode =
      unknownConnection.ok === false ? unknownConnection.error.code : 'ACCEPTED';

    const unopenedQuery = await db.queryRun({ connectionId: 'nope', sql: 'select 1' });
    out.unopenedQueryCode = unopenedQuery.ok === false ? unopenedQuery.error.code : 'ACCEPTED';

    // Deletion is tested in a second pass, after main has read the settings file
    // off disk — deleting here first would make the ciphertext check vacuous.
    return out;
  })()`)) as Record<string, unknown>;

    // Read the settings file straight off disk to confirm the secret is ciphertext
    // at rest. The renderer cannot tell us that, and trusting it would be circular.
    let onDisk: string;
    try {
      onDisk = readFileSync(join(settingsDir, 'settings.json'), 'utf8');
    } catch {
      onDisk = '';
    }

    const deletion = (await win.webContents.executeJavaScript(`(async () => {
    const db = window.tabby.db;
    const deleted = await db.deleteConnection('smoke-1');
    const missing = await db.deleteConnection('smoke-1');
    return {
      deleteOk: deleted.ok === true,
      deleteMissingCode: missing.ok === false ? missing.error.code : 'ACCEPTED',
    };
  })()`)) as { deleteOk: boolean; deleteMissingCode: string };

    /**
     * Optional live section: the columnar wire format across a **real Electron
     * IPC**, gated on TABBY_TEST_PG_*.
     *
     * The unit tests prove the codec round-trips through Node's `structuredClone`,
     * which is not the same serializer Electron uses for `invoke` results. If
     * Electron's structured clone flattened a `Float64Array` into a plain object,
     * the whole columnar design would be worthless and no unit test would notice.
     * This is the only place that can find out, so it decodes the bytes by hand in
     * the renderer rather than trusting anything on the main side.
     *
     * The password is injected from this process's environment and is never
     * written into an assertion, a log line, or the returned payload.
     */
    const pgUser = process.env['TABBY_TEST_PG_USER'] ?? '';
    const pgDatabase = process.env['TABBY_TEST_PG_DATABASE'] ?? '';
    const liveConfigured = LIVE_CONFIGURED;

    /**
     * Phase 7's second exit criterion, from the UI: **cancelling a runaway query**.
     *
     * The integration suite already proves `pg_cancel_backend` reaches the server in
     * ~1ms, including for a run that has not registered yet. That is not the same
     * claim. This drives the actual buttons — type a slow query, press Run, wait for
     * Cancel to become live, press it — and reads back the error banner the app
     * shows. It is the only place where "the cancel button works" is a measured
     * fact rather than an inference from wiring.
     *
     * `pg_sleep(60)` is used rather than a fixture function for the reason recorded
     * in `scripts/pg-fixtures.sql`: a set-returning function materialises, so there
     * would be nothing in flight to cancel.
     *
     * Needs a reload: the connection is saved through the bridge, but the renderer's
     * connection store loaded its list at mount and cannot see it otherwise. Saving
     * through the editor form instead would mean driving six more inputs to prove
     * nothing new.
     */
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    const uiCancel = liveConfigured
      ? await (async (): Promise<Record<string, unknown>> => {
          await win.webContents.executeJavaScript(`(async () => {
      const db = window.tabby.db;
      await db.saveConnection({
        connection: {
          id: 'smoke-ui',
          name: 'smoke ui',
          host: ${JSON.stringify(process.env['TABBY_TEST_PG_HOST'] ?? 'localhost')},
          port: ${JSON.stringify(Number(process.env['TABBY_TEST_PG_PORT'] ?? 5432))},
          database: ${JSON.stringify(pgDatabase)},
          user: ${JSON.stringify(pgUser)},
          sslMode: 'disable',
          createdAt: 0,
          updatedAt: 0,
        },
        password: ${JSON.stringify(process.env['TABBY_TEST_PG_PASSWORD'] ?? '')},
      });
    })()`);

          const reloaded = new Promise<void>((resolve) => {
            win.webContents.once('did-finish-load', () => resolve());
          });
          win.webContents.reload();
          await reloaded;
          await wait(1_500);

          return (await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { ran: false, error: null };
      const byText = (label) =>
        Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === label);

      const select = document.querySelector('select');
      if (!select) { out.error = 'no connection picker after reload'; return out; }
      select.value = 'smoke-ui';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);

      const open = byText('Open');
      if (!open) { out.error = 'no Open button'; return out; }
      open.click();
      await sleep(1500);

      const pane = document.querySelector('[data-query-editor]');
      const area = document.querySelector('[data-sql-input]');
      if (!pane || !area) { out.error = 'no editor'; return out; }

      area.value = 'select pg_sleep(60)';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);

      const run = pane.querySelector('[data-run]');
      if (run.disabled) { out.error = 'Run stayed disabled with a connection open'; return out; }
      run.click();
      out.ran = true;

      // Long enough to be on the server, short enough to stay well inside the 30s
      // statement_timeout — the cancel has to be what stops it.
      await sleep(1200);
      const cancel = pane.querySelector('[data-cancel]');
      out.cancelLiveWhileRunning = !cancel.disabled;
      out.cancelNamesTheQuery = /pg_sleep/.test(cancel.textContent || '');
      cancel.click();

      const deadline = Date.now() + 15000;
      let banner = '';
      while (Date.now() < deadline) {
        const element = document.querySelector('[data-run-error]');
        if (element) { banner = element.textContent || ''; break; }
        await sleep(100);
      }
      out.banner = banner.trim().slice(0, 140);
      out.cancelled = banner.includes('QUERY_CANCELLED');
      out.cancelInertAfterwards = pane.querySelector('[data-cancel]').disabled;
      // No result tab may have opened for a query that never returned a row.
      out.resultTabs = document.querySelectorAll('[role="tab"]').length;

      const db = window.tabby.db;
      await db.closeConnection('smoke-ui');
      await db.deleteConnection('smoke-ui');
      return out;
    })()`)) as Record<string, unknown>;
        })()
      : null;

    /**
     * Phase 8's exit criterion, from the UI: **a streamed export, and a cancel
     * mid-flight**.
     *
     * `tests/integration/pg-export.spec.ts` proves the same thing about main — a
     * million rows, a flat retained heap, a partial file kept on cancel. What only
     * this block can prove is the half the criterion actually names: that the
     * *renderer* stays flat while it happens, because renderer memory is only
     * observable from inside the renderer. `performance.memory` is sampled before
     * and after, and the rows are counted from main, off disk.
     *
     * It also asserts the security property the design rests on: a `path` smuggled
     * into `exportStart` is refused by the validator, and nothing appears at it.
     */
    const uiExport = liveConfigured
      ? await (async (): Promise<Record<string, unknown>> => {
          await win.webContents.executeJavaScript(`(async () => {
      const db = window.tabby.db;
      await db.saveConnection({
        connection: {
          id: 'smoke-export',
          name: 'smoke export',
          host: ${JSON.stringify(process.env['TABBY_TEST_PG_HOST'] ?? 'localhost')},
          port: ${JSON.stringify(Number(process.env['TABBY_TEST_PG_PORT'] ?? 5432))},
          database: ${JSON.stringify(pgDatabase)},
          user: ${JSON.stringify(pgUser)},
          sslMode: 'disable',
          createdAt: 0,
          updatedAt: 0,
        },
        password: ${JSON.stringify(process.env['TABBY_TEST_PG_PASSWORD'] ?? '')},
      });
    })()`);

          const reloadedForExport = new Promise<void>((resolve) => {
            win.webContents.once('did-finish-load', () => resolve());
          });
          win.webContents.reload();
          await reloadedForExport;
          await wait(1_500);

          return (await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { error: null, stage: 'start' };
      const db = window.tabby.db;
      // A hard budget for this block alone. Without it, one wait that never ends
      // takes the whole harness with it and the run reports nothing at all — which
      // is how the crash in driver-pg.ts stayed invisible for a full run.
      const blockDeadline = Date.now() + 150000;
      const expired = () => Date.now() > blockDeadline;
      const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : -1);
      const byText = (label) =>
        Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === label);
      const dialog = () => document.querySelector('[data-export-dialog]');
      const trayRows = () => document.querySelectorAll('[data-export-tray] [data-export-row]');
      const lastRow = () => { const all = trayRows(); return all[all.length - 1]; };
      const phaseOf = (row) => row ? row.querySelector('[data-export-phase]').textContent : '';

      out.stage = 'pick-connection';
      const select = document.querySelector('select');
      if (!select) { out.error = 'no connection picker after reload'; return out; }
      select.value = 'smoke-export';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);
      const openConnection = byText('Open');
      if (!openConnection) { out.error = 'no Open button'; return out; }
      openConnection.click();
      await sleep(1500);

      // ── The security property: no path can be smuggled in ─────────────────
      out.stage = 'smuggled-path';
      const options = {
        format: 'csv', delimiter: ',', includeHeader: true, nullText: '',
        encoding: 'utf8', lineEnding: 'crlf', writeBom: true, rowsPerInsert: 100,
      };
      const smuggled = await db.exportStart({
        resultId: 'does-not-exist', path: '/tmp/tabby-smuggled.csv', options,
      });
      out.pathRefusedByValidator =
        smuggled.ok === false && smuggled.error.code === 'VALIDATION_FAILED';
      const unknown = await db.exportStart({ resultId: 'nope', options });
      out.unknownResultRefused = unknown.ok === false;

      // ── A real result, exported through the buttons ───────────────────────
      out.stage = 'run-query';
      const pane = document.querySelector('[data-query-editor]');
      const area = document.querySelector('[data-sql-input]');
      if (!pane || !area) { out.error = 'no editor'; return out; }
      area.value = 'select * from fixtures.big limit 200000';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      pane.querySelector('[data-run]').click();

      const tabs = () => document.querySelectorAll('[role="tab"]').length;
      while (!expired() && tabs() < 2) await sleep(100);
      out.resultOpened = tabs() >= 2;
      out.tabsSeen = tabs();
      if (!out.resultOpened) { out.error = 'the query never produced a tab'; return out; }

      out.stage = 'open-dialog';
      const dialogButton = document.querySelector('[data-export-open]');
      out.exportEnabledWithResult = dialogButton.disabled === false;
      dialogButton.click();
      await sleep(300);

      out.dialogOpened = !!dialog();
      if (!out.dialogOpened) { out.error = 'the export dialog never opened'; return out; }
      out.stage = 'dialog-shape';
      out.dialogIsDialog = dialog().getAttribute('role') === 'dialog';
      out.fourFormats = dialog().querySelectorAll('[data-export-format]').length;
      // There is no destination field at all: the picker belongs to main, and a
      // renderer that could type a path could write anywhere the user can.
      out.noPathField =
        dialog().querySelector('input[type="file"]') === null &&
        !/save as/i.test(dialog().querySelector('.body').textContent || '');
      out.dialogSaysRowsBypassTheRenderer =
        /none pass through this window/.test(dialog().textContent || '');

      out.stage = 'export-200k';
      const heapBefore = heap();
      const startButton = dialog().querySelector('[data-export-start]');
      // Captured because a disabled button swallows a click silently: without this,
      // "nothing happened" and "the click was refused" are indistinguishable.
      out.startButtonDisabled = startButton.disabled === true;
      startButton.click();
      await sleep(400);
      const problem = dialog() ? dialog().querySelector('[data-export-problem]') : null;
      const dialogError = dialog() ? dialog().querySelector('[data-export-error]') : null;
      out.dialogProblem = problem ? problem.textContent.trim() : null;
      out.dialogError = dialogError ? dialogError.textContent.trim() : null;

      out.trayAppeared = false;
      const doneDeadline = Date.now() + 45000;
      while (!expired() && Date.now() < doneDeadline) {
        if (phaseOf(lastRow()) === 'done') { out.trayAppeared = true; break; }
        await sleep(100);
      }
      out.exportReachedDone = phaseOf(lastRow()) === 'done';
      out.exportPhaseSeen = phaseOf(lastRow());
      out.exportSummary = lastRow() ? lastRow().querySelector('[data-export-summary]').textContent : '';
      out.cancelReplacedByDismiss = !!lastRow() &&
        lastRow().querySelector('[data-export-cancel]') === null &&
        lastRow().querySelector('[data-export-dismiss]') !== null;

      // Chromium quantizes this without --enable-precise-memory-info, so it is a
      // magnitude and not a byte count. 200k rows of four columns is ~7MB of text;
      // a renderer that received them would show tens of megabytes, and one that
      // built a string of the whole file would show more.
      const heapAfter = heap();
      out.rendererHeapBeforeMB = Math.round(heapBefore / 1e6);
      out.rendererHeapAfterMB = Math.round(heapAfter / 1e6);
      out.rendererHeapDeltaMB = Math.round((heapAfter - heapBefore) / 1e6);
      if (!out.exportReachedDone) {
        out.error = 'the 200k export never reached done';
        return out;
      }
      if (expired()) { out.error = 'ran out of time during the 200k export'; return out; }

      // ── Cancel mid-flight ─────────────────────────────────────────────────
      out.stage = 'run-big-query';
      area.value = 'select * from fixtures.big limit 3000000';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      pane.querySelector('[data-run]').click();
      while (!expired() && tabs() < 3) await sleep(100);
      out.secondResultOpened = tabs() >= 3;
      if (!out.secondResultOpened) { out.error = 'the second query never produced a tab'; return out; }

      out.stage = 'cancel-export';
      dialogButton.click();
      await sleep(300);
      dialog().querySelector('[data-export-start]').click();

      // Wait for rows to have been written, so "cancelled mid-flight" means that
      // rather than "cancelled before it started" — which every later assertion
      // would also pass on.
      let sawProgress = false;
      while (!expired()) {
        const text = lastRow() ? lastRow().textContent : '';
        if (/rows written/.test(text) && !/\\b0 rows written/.test(text)) { sawProgress = true; break; }
        await sleep(100);
      }
      out.sawProgressBeforeCancel = sawProgress;

      const cancelButton = lastRow() ? lastRow().querySelector('[data-export-cancel]') : null;
      out.cancelButtonPresent = !!cancelButton;
      if (cancelButton) cancelButton.click();

      out.exportCancelled = false;
      while (!expired()) {
        if (phaseOf(lastRow()) === 'cancelled') {
          out.exportCancelled = true;
          out.cancelledSummary = lastRow().querySelector('[data-export-summary]').textContent;
          break;
        }
        await sleep(100);
      }

      // Bounded, and last: closing the connection waits for the export's client to
      // come back, so doing it while an export is still streaming would block.
      out.stage = 'cleanup';
      const cleanupDeadline = Date.now() + 20000;
      try {
        await Promise.race([
          (async () => {
            await db.closeConnection('smoke-export');
            await db.deleteConnection('smoke-export');
          })(),
          sleep(Math.max(0, cleanupDeadline - Date.now())),
        ]);
      } catch (error) {
        out.error = 'cleanup: ' + (error && error.message ? error.message : String(error));
      }
      out.stage = 'done';
      return out;
    })()`)) as Record<string, unknown>;
        })()
      : null;

    // Read the exported files off disk, from main. A renderer reporting a finished
    // export is exactly what a bug that wrote nothing would also report.
    const exportedFiles = exportedPaths.map((path) => {
      if (!existsSync(path)) return { path, exists: false, records: -1, bytes: -1 };
      const text = readFileSync(path, 'utf8');
      return {
        path,
        exists: true,
        records: text.split('\r\n').filter((line) => line !== '').length,
        bytes: Buffer.byteLength(text, 'utf8'),
      };
    });
    const smuggledFileCreated = existsSync('/tmp/tabby-smuggled.csv');

    const live = liveConfigured
      ? ((await win.webContents.executeJavaScript(`(async () => {
    const db = window.tabby.db;
    const out = { ran: false, error: null };
    const saved = await db.saveConnection({
      connection: {
        id: 'smoke-live',
        name: 'smoke live',
        host: ${JSON.stringify(process.env['TABBY_TEST_PG_HOST'] ?? 'localhost')},
        port: ${JSON.stringify(Number(process.env['TABBY_TEST_PG_PORT'] ?? 5432))},
        database: ${JSON.stringify(pgDatabase)},
        user: ${JSON.stringify(pgUser)},
        sslMode: 'disable',
        createdAt: 0,
        updatedAt: 0,
      },
      password: ${JSON.stringify(process.env['TABBY_TEST_PG_PASSWORD'] ?? '')},
    });
    if (!saved.ok) { out.error = 'save:' + saved.error.code; return out; }

    const opened = await db.openConnection('smoke-live');
    if (!opened.ok) { out.error = 'open:' + opened.error.code; return out; }

    // ── Phase 6: the catalog payload across a real Electron IPC ──────────────
    // Run before the query section and never allowed to abort it, so a catalog
    // regression reports itself instead of hiding behind an unrelated failure.
    try {
      const schemas = await db.schemaChildren({
        connectionId: 'smoke-live',
        parentSchema: null,
      });
      out.schemasOk = schemas.ok === true;
      out.schemaNames = schemas.ok ? schemas.value.map((n) => n.name) : [];

      const many = await db.schemaChildren({
        connectionId: 'smoke-live',
        parentSchema: 'fixtures_many',
      });
      out.manyCount = many.ok ? many.value.length : -1;
      out.manyFirstKind = many.ok && many.value[0] ? many.value[0].kind : null;
      out.manyHasChildren = many.ok && many.value[0] ? many.value[0].hasChildren : null;

      const detail = await db.schemaTable({
        connectionId: 'smoke-live',
        schema: 'fixtures',
        table: 'detail_sample',
      });
      out.detailOk = detail.ok === true;
      out.detailError = detail.ok ? null : detail.error.code;
      if (detail.ok) {
        const d = detail.value;
        out.detailKind = d.kind;
        out.detailColumnTypes = d.meta.columns.map((c) => c.formattedType);
        out.detailComment = d.meta.comment;
        out.detailIndexCount = d.indexes.length;
        out.detailHasPartialIndex = d.indexes.some(
          (i) => i.name === 'detail_sample_partial_uq',
        );
        out.detailHasExpressionIndex = d.indexes.some(
          (i) => i.definition.includes('lower((code)::text)'),
        );
        out.detailConstraintCount = d.constraints.length;
        out.detailHasNotNullConstraint = d.constraints.some((c) =>
          c.definition.startsWith('NOT NULL'),
        );
        out.detailDdlIsArray = Array.isArray(d.ddl);
        out.detailDdlCount = d.ddl.length;
        out.detailDdlStartsCreate =
          typeof d.ddl[0] === 'string' &&
          d.ddl[0].startsWith('create table "fixtures"."detail_sample" (');
        out.detailDdlEscapesNewline = d.ddl.some(
          (s) => typeof s === 'string' && s.includes('\\\\n'),
        );
      }

      const refreshed = await db.refreshSchema('smoke-live');
      out.refreshOk = refreshed.ok === true;
      out.refreshDropped = refreshed.ok ? refreshed.value : -1;
      out.catalogDone = true;
    } catch (e) {
      out.catalogError = String(e);
    }

    const run = await db.queryRun({
      connectionId: 'smoke-live',
      sql: 'select * from fixtures.big order by id',
      initialRows: 200,
    });
    if (!run.ok) { out.error = 'run:' + run.error.code; return out; }

    const page = await db.resultWindow({ resultId: run.value.resultId, startRow: 0, rowCount: 5 });
    if (!page.ok) { out.error = 'window:' + page.error.code; return out; }

    const block = page.value;
    const decoder = new TextDecoder();
    const text = (col, row) =>
      decoder.decode(col.bytes.subarray(col.offsets[row], col.offsets[row + 1]));
    const kindOf = (value) => Object.prototype.toString.call(value);

    out.ran = true;
    out.startRow = block.startRow;
    out.rowCount = block.rowCount;
    out.encodings = block.columns.map((c) => c.encoding);
    // The point of the exercise: are these still typed arrays after the bridge?
    out.nullsKind = kindOf(block.columns[0].nulls);
    out.offsetsKind = kindOf(block.columns[0].offsets);
    out.bytesKind = kindOf(block.columns[0].bytes);
    out.valuesKind = kindOf(block.columns[1].values);
    out.firstId = text(block.columns[0], 0);
    out.fifthId = text(block.columns[0], 4);
    out.firstLabel = text(block.columns[2], 0);
    out.bucketAt0 = block.columns[1].values[0];
    out.metaColumns = run.value.meta.columns.map((c) => c.name);
    out.metaRowCount = run.value.meta.rowCount;

    await db.resultDispose(run.value.resultId);
    await db.closeConnection('smoke-live');
    await db.deleteConnection('smoke-live');
    return out;
  })()`)) as Record<string, unknown>)
      : null;

    disposeIpc();
    // No session was ever opened (the harness has no database), but disposing is
    // what the real app does on quit and must not throw when there is nothing open.
    await db.dispose();
    rmSync(settingsDir, { recursive: true, force: true });

    const steps = interaction.steps ?? {};
    const ariaInfo = interaction.aria;
    const hostile = (ipc.hostile ?? {}) as Record<string, string>;
    const has = (text: string | undefined, needle: string): boolean =>
      typeof text === 'string' && text.includes(needle);

    /**
     * Assert on the payload handed to `clipboard.writeText`, not on the system
     * clipboard. Chromium requires *transient user activation* to write, and a
     * synthetic `dispatchEvent` is untrusted, so it can never provide one — the OS
     * clipboard stays empty in this harness no matter how correct the code is.
     * Verifying the intercepted payload proves the whole path (keydown → mapping →
     * selection → block fetch → serialisation) while the activation limit is a
     * property of the test, not of the app. The real read is reported for context.
     */
    // Bound call: detaching readText from `clipboard` loses Electron's `this` and
    // yields a non-string. The cast is on the result, because electron.d.ts merges
    // with the DOM Clipboard interface and TypeScript picks the Promise overload.
    const systemClipboard = String(clipboard.readText() as unknown);
    const payload = typeof steps.clipPayload === 'string' ? steps.clipPayload : '';
    const payloadLines: string[] = payload === '' ? [] : payload.split('\r\n');
    const payloadFields = payloadLines[0] ? payloadLines[0].split('\t').length : 0;
    const activation = JSON.parse(String(steps.userActivation ?? '{}')) as {
      isActive?: boolean | null;
    };

    const r = report as {
      bridgeType: string;
      versions: { electron?: string } | null;
      requireLeaked: boolean;
      processLeaked: boolean;
      bufferLeaked: boolean;
      canvasCount: number;
      canvasesSized: boolean;
      distinctColors: number;
      buttons: number;
      footerText: string;
      bodyBackground: string;
      evalBlocked: boolean;
      inlineScriptBlocked: boolean;
    };

    const assertions: [string, boolean][] = [
      ['bridge exposed as window.tabby', r.bridgeType === 'object'],
      ['versions reported across the bridge', Boolean(r.versions?.electron)],
      ['window.require not leaked', r.requireLeaked === false],
      ['window.process not leaked', r.processLeaked === false],
      ['window.Buffer not leaked', r.bufferLeaked === false],
      ['five canvas layers mounted', r.canvasCount === 5],
      ['every layer has a HiDPI backing store', r.canvasesSized],
      // background + stripe + text/gridline means cells were painted, not just cleared
      ['the grid painted pixels', r.distinctColors > 3],
      ['toolbar rendered', r.buttons >= 4],
      ['status bar mounted', r.footerText.length > 0],
      ['tailwind @theme token applied', r.bodyBackground === 'rgb(3, 11, 22)'],
      [`eval ${strict ? 'blocked' : 'allowed'} under ${profile} CSP`, r.evalBlocked === strict],
      [
        `inline script ${strict ? 'blocked' : 'allowed'} under ${profile} CSP`,
        r.inlineScriptBlocked === strict,
      ],
      // Turns the violation into positive evidence that the policy reached the
      // renderer, rather than eval failing for some unrelated reason.
      ['CSP enforcement observed in console log', !strict || cspEnforcement.length > 0],

      // ── Keyboard-only navigation reaches any cell ────────────────────────────
      ['Escape collapses to a single cell at A1', has(steps.afterEscape, 'rows 1–1')],
      ['ArrowDown moves to row 2', has(steps.afterArrowDown, 'rows 2–2')],
      ['ArrowRight moves to column 2', has(steps.afterArrowRight, 'cols 2–2')],
      ['shift+arrows build a 4x3 block (12 cells)', has(steps.afterBlock, '12 cells')],
      ['cmd+End reaches the last cell of 1M rows', has(steps.afterCmdEnd, 'rows 1000000')],
      ['cmd+End reaches the last column', has(steps.afterCmdEnd, 'cols 30')],
      ['cmd+Home returns to the first cell', has(steps.afterCmdHome, 'rows 1–1')],
      ['PageDown advances by a viewport', has(steps.afterPageDown, '1 cell')],

      // ── Copy serialises an Excel-correct block ───────────────────────────────
      ['cmd+C triggered exactly one clipboard write', steps.clipCalls === '[65]' || payload !== ''],
      ['copied block has 4 rows', payloadLines.length === 4],
      ['every copied row has 3 tab-separated fields', payloadFields === 3],
      [
        'all copied rows are uniform',
        payloadLines.length > 0 && payloadLines.every((line) => line.split('\t').length === 3),
      ],
      ['no unhandled rejection from the copy path', steps.rejections === '[]'],
      // Informational, not an assertion: synthetic events cannot supply the user
      // activation Chromium requires, so this is expected to be empty here.
      ['(report) system clipboard reachable', typeof systemClipboard === 'string'],
      ['(report) synthetic event lacked user activation', activation.isActive === false],

      // ── ARIA proxy carries true totals and absolute indices ──────────────────
      ['proxy grid is present', ariaInfo !== null],
      ['aria-rowcount reports the true total (1M + header)', ariaInfo?.rowCount === '1000001'],
      ['aria-colcount reports the true width', ariaInfo?.colCount === '30'],
      ['proxy grid is labelled', typeof ariaInfo?.label === 'string' && ariaInfo.label.length > 0],
      ['proxy mirrors the visible window', Number(ariaInfo?.mirroredRows ?? 0) > 0],
      ['mirrored rows use absolute 1-based indices', Number(ariaInfo?.firstRowIndex ?? 0) >= 2],
      ['each mirrored row carries every column', Number(ariaInfo?.cellsInFirstRow ?? 0) === 30],
      ['selected cells are exposed to assistive tech', Number(ariaInfo?.selectedCells ?? 0) > 0],
      ['live region announced the active cell', String(ariaInfo?.liveText ?? '').length > 0],

      // ── Schema explorer mounts under the production CSP ─────────────────────
      ['schema tree pane is present', tree['panePresent'] === true],
      ['the tree declares itself a tree', tree['treeRoles'] === 0 || tree['treeRoles'] === 1],
      [
        'with no connection open it shows the empty state, not a scroller',
        tree['emptyState'] === true && tree['scrollerPresent'] === false,
      ],
      ['no tree rows exist before a connection is open', tree['treeitems'] === 0],
      ['the filter box is present', tree['filterPresent'] === true],
      ['the refresh control is present', tree['refreshPresent'] === true],
      [
        'the detail pane is mounted and invites a selection',
        tree['detailPresent'] === true && tree['detailInvites'] === true,
      ],

      // ── Query editor: highlight layer and lexer-aware splitting ─────────────
      ['the query editor is present', editor['present'] === true],
      [
        'the highlight layer, gutter and current-line rule all render',
        editor['hasHighlightLayer'] === true &&
          editor['hasGutter'] === true &&
          editor['hasCurrentLine'] === true,
      ],
      // The property the whole stacked-textarea design rests on.
      [
        'the highlighted text is character-identical to the source',
        editor['textMatchesSource'] === true,
      ],
      ['tokens are coloured', Number(editor['spanCount']) > 0],
      [
        'keywords and strings get distinct classes',
        editor['hasKeywordSpan'] === true && editor['hasStringSpan'] === true,
      ],
      ['a semicolon in a line comment does not split', editor['commentDoesNotSplit'] === true],
      ['a semicolon in a $$ body does not split', editor['dollarDoesNotSplit'] === true],
      [
        'a semicolon in an E-string with an escaped quote does not split',
        editor['escapeStringDoesNotSplit'] === true,
      ],
      ['a real separator does split', editor['realSeparatorSplits'] === true],
      [
        // Chromium normalizes a bare CR in parsed HTML away and happy-dom does not,
        // so only this harness can prove the `&#13;` escaping is doing its job. A
        // mismatch here means a Windows-line-ending paste misaligns every line.
        'a CRLF script keeps the two layers character-identical',
        editor['crlfTextMatches'] === true &&
          editor['crlfRenderedLength'] === editor['crlfSourceLength'],
      ],
      ['HTML in a query creates no element', Number(editor['injectedElements']) === 0],
      ['HTML in a query is escaped, not parsed', editor['escapedAngle'] === true],
      [
        'an unterminated literal is reported and still highlighted',
        editor['unterminatedReported'] === true && editor['unterminatedStillHighlighted'] === true,
      ],
      [
        'run, run-all, explain and cancel are all wired',
        editor['runPresent'] === true &&
          editor['runAllPresent'] === true &&
          editor['explainPresent'] === true &&
          editor['cancelPresent'] === true,
      ],
      [
        'run and cancel are disabled with no connection open',
        editor['runDisabled'] === true && editor['cancelDisabled'] === true,
      ],

      // ── Query history ──────────────────────────────────────────────────────
      ['history is on the bridge', history['hasBridge'] === true],
      [
        'a recorded run comes back with an id and timestamp main generated',
        history['addOk'] === true &&
          history['addCarriesMainId'] === true &&
          history['addCarriesMainTimestamp'] === true &&
          history['addEchoesTheStatement'] === true,
      ],
      [
        'the log lists newest first, with its status and connection',
        history['listOk'] === true &&
          Number(history['listCount']) === 3 &&
          history['listNewestFirst'] === true &&
          history['listCarriesStatus'] === true &&
          history['listCarriesLabel'] === true &&
          history['listSkippedNothing'] === true,
      ],
      [
        'a delete removes exactly the entry main handed back an id for',
        history['deleteOk'] === true &&
          Number(history['countAfterDelete']) === 2 &&
          history['deleteTwiceIsNotFound'] === true,
      ],
      ['a limit narrows the response', history['limitHonoured'] === true],
      [
        '5/5 hostile history payloads rejected, none threw, none wrote',
        Number(history['hostileRejected']) === Number(history['hostileTotal']) &&
          Number(history['hostileTotal']) === 5 &&
          Number(history['hostileThrew']) === 0 &&
          history['countUnchangedByHostile'] === true,
      ],
      ['an over-cap limit is refused', history['limitBeyondCapRefused'] === true],
      [
        'the panel opens as a labelled dialog and shows the privacy note',
        history['togglePresent'] === true &&
          history['panelOpened'] === true &&
          history['panelIsDialog'] === true &&
          history['panelIsLabelled'] === true &&
          history['privacyNoteShown'] === true &&
          Number(history['rowsRendered']) === 3,
      ],
      ['the filter narrows the list', history['filterNarrowsToOne'] === true],
      [
        // The property that would otherwise silently corrupt a restored query: the
        // row shows a collapsed preview, but the editor must receive the statement.
        'clicking a row restores the statement into the editor and closes the panel',
        history['rowFound'] === true &&
          history['editorReceivedStatement'] === true &&
          history['panelClosedAfterLoad'] === true,
      ],
      ['Escape closes the panel', history['reopened'] === true && history['escapeClosed'] === true],
      [
        // Asserted from main, not from the renderer: a renderer cannot attest to
        // its own persistence, and the privacy note is a claim about the filesystem.
        'the log is real JSONL inside userData, one line per run',
        historyOnDisk.includes('history.jsonl') &&
          historyLines.length === 3 &&
          escapedOutsideHistoryDir.length === 0,
      ],
      [
        'clearing takes two clicks and then empties the panel',
        historyCleared['clearPresent'] === true &&
          historyCleared['firstClickOnlyArms'] === true &&
          historyCleared['armedLabelChanged'] === true &&
          historyCleared['emptyStateShown'] === true &&
          Number(historyCleared['countAfterClear']) === 0,
      ],
      [
        // Found by this harness, not by a unit test: the store's filter survived a
        // close, so reopening showed one row of three. `reopenedWithRows` is the
        // assertion that would have passed at 1 and looked fine.
        'reopening the panel shows the whole log, not last filter',
        historyCleared['filterResetOnReopen'] === true &&
          Number(historyCleared['reopenedWithRows']) === 3,
      ],
      [
        'clearing removes the bytes, not just the rows',
        historyFilesAfterClear.length === 0 && historyCleared['closedAtEnd'] === true,
      ],

      // ── Command palette and theme ──────────────────────────────────────────
      [
        'the theme toggle flips the document and persists the choice',
        chrome['themeTogglePresent'] === true &&
          chrome['themeFlipped'] === true &&
          chrome['themeMatchesSetting'] === true &&
          chrome['themeRestored'] === true,
      ],
      [
        // Computed style, so a Tailwind build that dropped the light-theme block
        // fails here rather than shipping a toggle that only moves an attribute.
        `the theme actually repaints (${String(chrome['backgroundBefore'])} → ${String(chrome['backgroundAfter'])})`,
        chrome['themeActuallyRepainted'] === true && chrome['backgroundRestored'] === true,
      ],
      [
        'the palette opens as a dialog and lists commands',
        chrome['paletteButtonPresent'] === true &&
          chrome['paletteOpened'] === true &&
          chrome['paletteIsDialog'] === true &&
          chrome['paletteHasInput'] === true &&
          Number(chrome['paletteListsCommands']) >= 3,
      ],
      [
        // The filtering property: a command that cannot run is not listed at all.
        'the palette lists only commands that can actually run',
        chrome['noQueryCommandWithoutConnection'] === true &&
          chrome['noResultCommandWithoutResult'] === true,
      ],
      [
        'export is refused while no live result is open',
        chrome['exportDisabledWithNoResult'] === true,
      ],
      [
        // 'thm' is not a substring of 'Theme': only a subsequence match finds it.
        'a fuzzy query ranks its command first and highlights the matched letters',
        chrome['fuzzyMatched'] === true &&
          chrome['fuzzyTopIsTheme'] === true &&
          chrome['matchedLettersHighlighted'] === true,
      ],
      ['a query that matches nothing says so', chrome['noMatchSaysSo'] === true],
      [
        // The matcher never builds a RegExp from the query. If it did, this would
        // hang the renderer and the watchdog would report an unrelated timeout.
        'regex metacharacters in a query are a non-match, not a hang',
        chrome['metacharacterQuerySurvived'] === true,
      ],
      [
        'Enter runs the top command and closes the palette',
        chrome['enterRunsTopCommand'] === true && chrome['historyClosedAgain'] === true,
      ],
      [
        'Escape closes the palette and ⌘K reopens it',
        chrome['escapeClosedPalette'] === true &&
          chrome['cmdKReopened'] === true &&
          chrome['closedAtEnd'] === true,
      ],

      // ── IPC contract ───────────────────────────────────────────────────────
      ['bridge exposes the db API', ipc.hasDb === true],
      ['bridge exposes event subscriptions', ipc.hasEvents === true],
      ['bridge object is frozen', ipc.frozen === true],
      ['ipcRenderer not leaked', ipc.ipcRendererLeaked === false],
      ['settings round-trips', ipc.settingsOk === true],
      [
        'settings patch persists',
        ipc.themeAfterPatch === 'light' && ipc.themePersisted === 'light',
      ],
      ['connection saved', ipc.saveOk === true],
      ['connection listed back', ipc.listCount === 1],
      [
        'summary carries no secret field',
        Array.isArray(ipc.summaryKeys) &&
          !ipc.summaryKeys.includes('encryptedPassword') &&
          !ipc.summaryKeys.includes('password'),
      ],
      ['summary contains no plaintext password', ipc.summaryLeaksSecret === false],
      ['list contains no plaintext password', ipc.listLeaksSecret === false],
      ['list contains no ciphertext either', ipc.listLeaksCiphertext === false],
      // The renderer cannot verify this; reading the file from main is the point.
      [
        'password is ciphertext at rest',
        onDisk.includes('enc(') && !onDisk.includes('sup3r-s3cret-do-not-log'),
      ],
      ['connection deleted', deletion.deleteOk === true],
      ['deleting twice reports NOT_FOUND', deletion.deleteMissingCode === 'NOT_FOUND'],
      [
        'an unknown result id answers RESULT_NOT_FOUND, not a throw',
        ipc.unknownResultCode === 'RESULT_NOT_FOUND',
      ],
      [
        'an unknown connection id answers NOT_FOUND, not a throw',
        ipc.unknownConnectionCode === 'NOT_FOUND',
      ],
      [
        'a query on an unopened connection answers NOT_FOUND, not a throw',
        ipc.unopenedQueryCode === 'NOT_FOUND',
      ],
      [
        'no channel threw across the bridge',
        !Object.values(hostile).some((v) => String(v).startsWith('THREW')),
      ],
      ['no hostile payload was accepted', !Object.values(hostile).some((v) => v === 'ACCEPTED')],
      [
        'every hostile payload was tagged VALIDATION_FAILED',
        Object.values(hostile).every((v) => v === 'VALIDATION_FAILED'),
      ],
      ['prototype pollution did not reach Object.prototype', ipc.protoPolluted === false],

      // ── Live-database section ────────────────────────────────────────────────
      // Present only when TABBY_TEST_PG_* is set, so `npm run smoke` stays
      // self-contained and the integration job is what exercises this.
      ...(live === null
        ? []
        : ([
            [
              `live: a real query crossed the bridge${live['error'] ? ` (${String(live['error'])})` : ''}`,
              live['ran'] === true,
            ],
            // The reason this section exists: Electron's serializer is not Node's
            // structuredClone, and a flattened typed array would silently turn the
            // columnar codec into a slow object graph.
            [
              'live: nulls bitmap is still a Uint8Array',
              live['nullsKind'] === '[object Uint8Array]',
            ],
            [
              'live: offsets are still a Uint32Array',
              live['offsetsKind'] === '[object Uint32Array]',
            ],
            [
              'live: the UTF-8 blob is still a Uint8Array',
              live['bytesKind'] === '[object Uint8Array]',
            ],
            [
              'live: numerics are still a Float64Array',
              live['valuesKind'] === '[object Float64Array]',
            ],
            [
              'live: each column kept its intended encoding',
              JSON.stringify(live['encodings']) === '["utf8","float64","utf8","utf8"]',
            ],
            ['live: block shape survived', live['startRow'] === 0 && live['rowCount'] === 5],
            // Decoded by hand in the renderer from the raw bytes, so this proves the
            // payload is intact rather than that our own decoder agrees with itself.
            ['live: int8 text is byte-exact (row 1)', live['firstId'] === '1'],
            ['live: int8 text is byte-exact (row 5)', live['fifthId'] === '5'],
            ['live: text column is byte-exact', live['firstLabel'] === 'row-1'],
            ['live: int4 decoded to the right number', live['bucketAt0'] === 1],
            [
              'live: column metadata crossed the bridge',
              JSON.stringify(live['metaColumns']) === '["id","bucket","label","payload"]',
            ],
            // A cursor result reports -1 until it reaches the end: main must not
            // re-run the user's query just to count it.
            ['live: row count is unknown, not guessed', live['metaRowCount'] === -1],

            // ── Phase 6: the catalog payload ─────────────────────────────────
            [
              `live: the schema tree crossed the bridge${live['catalogError'] ? ` (${String(live['catalogError'])})` : ''}`,
              live['catalogDone'] === true && live['schemasOk'] === true,
            ],
            [
              'live: the 2,000-table fixture schema is listed',
              Array.isArray(live['schemaNames']) &&
                (live['schemaNames'] as string[]).includes('fixtures_many'),
            ],
            ['live: all 2,000 relations crossed in one payload', live['manyCount'] === 2_000],
            [
              'live: relation nodes arrive typed and childless',
              live['manyFirstKind'] === 'table' && live['manyHasChildren'] === false,
            ],
            [
              `live: the table detail crossed the bridge${live['detailError'] ? ` (${String(live['detailError'])})` : ''}`,
              live['detailOk'] === true && live['detailKind'] === 'table',
            ],
            // The reason `format_type` is read at all: without the modifiers the
            // pane would say `varchar` and the generated DDL would not recreate it.
            [
              'live: type modifiers survived the bridge',
              JSON.stringify(live['detailColumnTypes']) ===
                '["bigint","integer","character varying(64)","character varying(255)",' +
                  '"numeric(12,4)","timestamp with time zone","text"]',
            ],
            [
              'live: the table comment survived',
              live['detailComment'] === 'the detail-pane comparison fixture',
            ],
            [
              'live: expression and partial indexes are both listed',
              live['detailIndexCount'] === 5 &&
                live['detailHasPartialIndex'] === true &&
                live['detailHasExpressionIndex'] === true,
            ],
            // PostgreSQL 18 stores NOT NULL in pg_constraint. Dropping those rows
            // is what keeps the pane from listing every NOT NULL column twice.
            [
              'live: PostgreSQL 18 NOT NULL rows are dropped',
              live['detailConstraintCount'] === 4 && live['detailHasNotNullConstraint'] === false,
            ],
            [
              'live: generated DDL arrived as separate statements',
              live['detailDdlIsArray'] === true &&
                live['detailDdlCount'] === 5 &&
                live['detailDdlStartsCreate'] === true,
            ],
            [
              'live: a multi-line comment was escaped, not split',
              live['detailDdlEscapesNewline'] === true,
            ],
            [
              'live: refresh invalidated the catalog cache',
              live['refreshOk'] === true && Number(live['refreshDropped']) > 0,
            ],
          ] as [string, boolean][])),

      // ── Cancelling a runaway query from the UI (Phase 7 exit criterion) ──────
      ...(uiCancel === null
        ? []
        : ([
            [
              `ui: the cancel run reached the server${uiCancel['error'] ? ` (${String(uiCancel['error'])})` : ''}`,
              uiCancel['ran'] === true,
            ],
            [
              'ui: Cancel becomes live while a query is on the server',
              uiCancel['cancelLiveWhileRunning'] === true,
            ],
            [
              'ui: Cancel names the query it is about to stop',
              uiCancel['cancelNamesTheQuery'] === true,
            ],
            [
              'ui: cancelling a runaway query surfaces QUERY_CANCELLED',
              uiCancel['cancelled'] === true,
            ],
            ['ui: Cancel is inert again afterwards', uiCancel['cancelInertAfterwards'] === true],
            // The demo tab is seeded on mount; a cancelled run must not add one.
            [
              'ui: no result tab opened for a query that never returned a row',
              Number(uiCancel['resultTabs']) <= 1,
            ],
          ] as [string, boolean][])),

      // ── Streaming export from the UI (Phase 8 exit criterion) ────────────────
      ...(uiExport === null
        ? []
        : ([
            [
              `ui: the export run reached a result${uiExport['error'] ? ` (${String(uiExport['error'])})` : ''}`,
              uiExport['resultOpened'] === true,
            ],
            [
              // The design's whole security argument: the renderer cannot choose a
              // destination, so a compromised one cannot write anywhere it likes.
              'ui: a path smuggled into exportStart is refused and nothing is written there',
              uiExport['pathRefusedByValidator'] === true && smuggledFileCreated === false,
            ],
            ['ui: an unknown result cannot be exported', uiExport['unknownResultRefused'] === true],
            [
              'ui: the export dialog offers all four formats and no destination field',
              uiExport['dialogOpened'] === true &&
                uiExport['dialogIsDialog'] === true &&
                Number(uiExport['fourFormats']) === 4 &&
                uiExport['noPathField'] === true &&
                uiExport['dialogSaysRowsBypassTheRenderer'] === true,
            ],
            [
              'ui: Export becomes available once a live result is open',
              uiExport['exportEnabledWithResult'] === true,
            ],
            [
              'ui: a 200k-row export streams to done and the tray reports it',
              uiExport['trayAppeared'] === true &&
                uiExport['exportReachedDone'] === true &&
                /200,000 rows/.test(String(uiExport['exportSummary'] ?? '')) &&
                uiExport['cancelReplacedByDismiss'] === true,
            ],
            [
              // Counted in main, off disk. A renderer reporting "done" is exactly
              // what a bug that wrote nothing would also report.
              'ui: the exported file really holds 200,000 records plus a header',
              exportedFiles[0]?.exists === true && exportedFiles[0]?.records === 200_001,
            ],
            [
              // The half of the exit criterion only a renderer can measure. The
              // budget is generous on purpose: Chromium quantizes this number
              // without --enable-precise-memory-info, so it is a magnitude check
              // against a design where rows never cross the bridge at all.
              `ui: the renderer heap stayed flat during the export (delta ${String(uiExport['rendererHeapDeltaMB'])}MB)`,
              Number(uiExport['rendererHeapDeltaMB']) < 150,
            ],
            [
              'ui: a large export can be cancelled mid-flight and says so',
              uiExport['secondResultOpened'] === true &&
                uiExport['sawProgressBeforeCancel'] === true &&
                uiExport['cancelButtonPresent'] === true &&
                uiExport['exportCancelled'] === true,
            ],
            [
              // The cancelled file survives, and holds records — "kept the partial
              // file" is only meaningful if there is something in it, and "partial"
              // is only meaningful if it stopped before the end.
              'ui: cancelling keeps a partial file that is neither empty nor complete',
              exportedFiles[1]?.exists === true &&
                Number(exportedFiles[1]?.records) > 1 &&
                Number(exportedFiles[1]?.records) < 3_000_001,
            ],
          ] as [string, boolean][])),

      ['no unexpected console errors', problems.length === 0],
    ];

    const failures = assertions.filter(([, passed]) => !passed).map(([name]) => name);

    process.stdout.write(
      `${JSON.stringify(
        {
          target,
          profile,
          report,
          interaction,
          tree,
          editor,
          history: {
            ...history,
            onDisk: historyOnDisk,
            linesOnDisk: historyLines.length,
            filesAfterClear: historyFilesAfterClear,
          },
          historyCleared,
          chrome,
          uiCancel,
          uiExport,
          exportedFiles,
          clipboard: {
            payloadLines: payloadLines.length,
            payloadFields,
            firstLine: payloadLines[0] ?? '',
            systemClipboardLength: systemClipboard.length,
            userActivation: activation,
          },
          cspEnforcement,
          ipc: { ...ipc, hostile, deletion, onDiskHasCiphertext: onDisk.includes('enc(') },
          problems,
          assertions: assertions.map(([name, passed]) => ({ name, passed })),
          failures,
        },
        null,
        2,
      )}\n`,
    );

    app.exit(failures.length > 0 ? 1 : 0);
  })
  .catch((error: unknown) => {
    // Without this, a throw inside the async body becomes an unhandled rejection
    // and app.exit() never runs — the harness would sit until the watchdog fires.
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`FAIL: smoke harness threw:\n${detail}\n`);
    app.exit(1);
  });
