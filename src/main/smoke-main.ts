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
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySecurityGuards, type CspProfile } from './security/navigation';

const defaultUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
const target = process.env['TABBY_SMOKE_URL'] ?? defaultUrl;
const profile: CspProfile = process.env['TABBY_SMOKE_CSP'] === 'dev' ? 'dev' : 'prod';

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

app.whenReady().then(async () => {
  applySecurityGuards(profile);

  const win = new BrowserWindow({
    show: false,
    backgroundColor: '#030b16',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
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

  await win.loadURL(target);
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
    ['no unexpected console errors', problems.length === 0],
  ];

  const failures = assertions.filter(([, passed]) => !passed).map(([name]) => name);

  process.stdout.write(
    `${JSON.stringify({ target, profile, report, cspEnforcement, problems, failures }, null, 2)}\n`,
  );

  app.exit(failures.length > 0 ? 1 : 0);
});
