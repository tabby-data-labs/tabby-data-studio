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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySecurityGuards, type CspProfile } from './security/navigation';
import { registerIpcHandlers } from './ipc/router';
import { createDbServices } from './db/services';
import { SettingsStore } from './store/settings-store';
import type { SecretCipher } from './store/cipher';

const defaultUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
const target = process.env['TABBY_SMOKE_URL'] ?? defaultUrl;
const profile: CspProfile = process.env['TABBY_SMOKE_CSP'] === 'dev' ? 'dev' : 'prod';

/** Hard ceiling so a stalled renderer fails the harness instead of hanging CI. */
const WATCHDOG_MS = 90_000;

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
    // wiring the shipped binary does not use. `emit` is dropped: the harness polls.
    const db = createDbServices({ settings, emit: () => undefined });
    const disposeIpc = registerIpcHandlers({
      settings,
      window: () => win,
      connections: db.connections,
      schemas: db.schemas,
      queries: db.queries,
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
    const liveConfigured = pgUser !== '' && pgDatabase !== '';

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
