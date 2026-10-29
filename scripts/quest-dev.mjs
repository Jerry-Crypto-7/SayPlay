/**
 * Quest 2 přes USB: otevře PLAY v prohlížeči brýlí a volitelně změří FPS (P65 T7).
 *
 *   node scripts/quest-dev.mjs                    # najde adb a brýle, přesměruje port, otevře hru
 *   node scripts/quest-dev.mjs --fps 60           # totéž a pak 60 s čte FPS z logcatu
 *   node scripts/quest-dev.mjs --port 3168        # server na jiném portu (výchozí 3165)
 *   node scripts/quest-dev.mjs --cdp              # ovládání prohlížeče brýlí přes Chrome DevTools Protocol
 *   node scripts/quest-dev.mjs --cdp --probe      # co prohlížeč Questu umí → evals/vr/quest-caps.json (P67 T1)
 *
 * `adb reverse tcp:3165 tcp:3165` udělá z počítačového serveru v brýlích
 * `localhost:3165`. Na tom záleží: WebXR pustí jen bezpečný původ (HTTPS nebo
 * localhost), adresa počítače v síti by „Enter VR“ nenabídla.
 *
 * `--cdp` přesměruje opačným směrem `tcp:9222` na ladicí soket prohlížeče brýlí
 * (`localabstract:chrome_devtools_remote`). Skript pak vidí otevřené stránky a smí
 * v nich spustit kód nebo klepnout; klepnutí z CDP prohlížeč bere jako skutečné.
 *
 * Výsledek měření jde do `evals/vr/quest2-fps.json`. Bez jediného vzorku se nic
 * nezapíše – nula v souboru by vypadala jako změřená hra, která nejede.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PORT = 3165;
export const CDP_PORT = 9222;
/** Hra v brýlích s panelem FPS. „Enter VR“ od P67 T1 nepotřebuje `?vr=1`. */
export const gameUrl = (port = PORT, path = '/play') => `http://localhost:${String(port)}${path}?vrhud=1`;
export const GAME_URL = gameUrl();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FPS_FILE = join(ROOT, 'evals', 'vr', 'quest2-fps.json');
const CAPS_FILE = join(ROOT, 'evals', 'vr', 'quest-caps.json');
const USAGE = 'usage: node scripts/quest-dev.mjs [--port <n>] [--fps <sekundy>] [--cdp [--probe]]';

/**
 * Volby příkazové řádky.
 *
 * @param {string[]} argv
 * @returns {{ port: number, fps: number | null, cdp: boolean, probe: boolean } | { error: string }}
 */
export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { port: { type: 'string' }, fps: { type: 'string' }, cdp: { type: 'boolean' }, probe: { type: 'boolean' } },
    }));
  } catch (error) {
    return { error: `${String(error.message)}\n${USAGE}` };
  }
  const port = values.port === undefined ? PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `--port chce číslo portu 1–65535.\n${USAGE}` };
  const fps = values.fps === undefined ? null : Number(values.fps);
  if (fps !== null && !(fps > 0)) return { error: `--fps chce počet sekund větší než nula.\n${USAGE}` };
  const cdp = values.cdp === true;
  const probe = values.probe === true;
  if (probe && !cdp) return { error: `--probe běží přes CDP, přidej --cdp.\n${USAGE}` };
  return { port, fps, cdp, probe };
}

/**
 * Přesměrování ladicího soketu prohlížeče brýlí na `localhost:<cdpPort>` počítače.
 *
 * @param {string} serial
 * @param {number} [cdpPort]
 * @returns {string[]}
 */
export function cdpForwardArgs(serial, cdpPort = CDP_PORT) {
  return ['-s', serial, 'forward', `tcp:${String(cdpPort)}`, 'localabstract:chrome_devtools_remote'];
}

/**
 * Ze seznamu cílů CDP (`/json`) stránka, která má otevřený náš server.
 *
 * @param {ReadonlyArray<{ type?: string, url?: string, webSocketDebuggerUrl?: string }>} targets
 * @param {number} port
 * @returns {{ url: string, webSocketDebuggerUrl: string } | null}
 */
export function pickPage(targets, port) {
  const origin = `http://localhost:${String(port)}/`;
  const page = targets.find((target) => target.type === 'page' && typeof target.url === 'string' && target.url.startsWith(origin) && typeof target.webSocketDebuggerUrl === 'string');
  return page === undefined ? null : { url: page.url, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
}

/**
 * Výstup `dumpsys activity activities` → aplikace v popředí brýlí (`balíček/.Aktivita`), jinak `null`. Systémový
 * dialog Questu v popředí (třeba po probuzení bez nasazených brýlí) drží prohlížeč na pozadí a stránka se nenačte.
 *
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseResumedActivity(stdout) {
  const match = /ResumedActivity: ActivityRecord\{\S+ \S+ (\S+)/.exec(stdout);
  return match ? match[1] : null;
}

/**
 * Spojení s jednou stránkou přes CDP: `send(method, params)` vrátí `result`, chyba protokolu odmítne slib.
 *
 * @param {string} wsUrl
 * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} [options]
 * @returns {Promise<{ send: (method: string, params?: object) => Promise<any>, close: () => void }>}
 */
export function cdpConnect(wsUrl, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 30_000 } = {}) {
  const socket = new WebSocketImpl(wsUrl);
  let nextId = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const pending = waiting.get(message.id);
    if (pending === undefined) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(`CDP: ${String(message.error.message)}`));
    else pending.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((done, failed) => {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        failed(new Error(`CDP: ${method} neodpověděl do ${String(timeoutMs)} ms`));
      }, timeoutMs);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          failed(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((done, failed) => {
    socket.addEventListener('open', () => done({ send, close: () => socket.close() }), { once: true });
    socket.addEventListener('error', () => failed(new Error(`CDP: spojení s ${wsUrl} selhalo`)), { once: true });
  });
}

/**
 * Výraz spuštěný ve stránce brýlí; vrátí jeho hodnotu (sliby počká). Výjimka ve stránce odmítne slib.
 *
 * @param {{ send: (method: string, params?: object) => Promise<any> }} cdp
 * @param {string} expression
 * @param {{ userGesture?: boolean }} [options]
 */
export async function cdpEvaluate(cdp, expression, { userGesture = false } = {}) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
  if (exceptionDetails) throw new Error(`stránka: ${String(exceptionDetails.exception?.description ?? exceptionDetails.text)}`);
  return result.value;
}

/**
 * Sonda schopností prohlížeče mimo relaci. Diktování se jen zkusí spustit a hned zruší: zajímá nás, jestli `start()`
 * vyhodí chybu nebo pošle `error` (třeba `not-allowed`), ne přepis. Žádná volba prohlížeče se tím nemění.
 */
export const PROBE_PAGE = `(async () => {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const dictation = { SpeechRecognition: 'SpeechRecognition' in window, webkitSpeechRecognition: 'webkitSpeechRecognition' in window, startThrew: null, error: null, started: false };
  if (Recognition !== undefined) {
    try {
      const recognition = new Recognition();
      recognition.onerror = (event) => { dictation.error = String(event.error); };
      recognition.onstart = () => { dictation.started = true; };
      recognition.start();
      dictation.startThrew = false;
      await new Promise((done) => setTimeout(done, 3000));
      recognition.abort();
    } catch (error) {
      dictation.startThrew = true;
      dictation.error = String(error && error.name ? error.name : error);
    }
  }
  let immersiveVr = null;
  try { immersiveVr = navigator.xr ? await navigator.xr.isSessionSupported('immersive-vr') : false; } catch (error) { immersiveVr = 'threw: ' + String(error); }
  return {
    userAgent: navigator.userAgent,
    immersiveVr,
    dictation,
    share: typeof navigator.share === 'function',
    serviceWorker: 'serviceWorker' in navigator,
  };
})()`;

/** Zachytí relaci, kterou stránka dostane po „Enter VR“, do `window.__probeSession`. */
export const PROBE_HOOK = `(() => {
  const xr = navigator.xr;
  if (!xr || xr.__probeHooked) return false;
  const request = xr.requestSession.bind(xr);
  xr.requestSession = async (...args) => { const session = await request(...args); window.__probeSession = session; return session; };
  xr.__probeHooked = true;
  return true;
})()`;

/** Střed tlačítka „Enter VR“ v CSS pixelech stránky, nebo `null`, dokud není vidět. */
export const ENTER_VR_RECT = `(() => {
  const button = document.querySelector('[data-testid="enter-vr"]');
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
})()`;

/** Co relace hlásí: obnovovací frekvence a vibrace ovladačů. Pak ji ukončí, brýle zůstanou, jak byly. */
export const PROBE_SESSION = `(async () => {
  const session = window.__probeSession;
  if (!session) return null;
  const controllers = Array.from(session.inputSources).map((source) => ({
    handedness: source.handedness,
    hapticActuators: source.gamepad && source.gamepad.hapticActuators ? source.gamepad.hapticActuators.length : 0,
    vibrationActuator: Boolean(source.gamepad && source.gamepad.vibrationActuator),
  }));
  const report = {
    supportedFrameRates: session.supportedFrameRates ? Array.from(session.supportedFrameRates) : null,
    frameRate: session.frameRate ?? null,
    updateTargetFrameRate: typeof session.updateTargetFrameRate === 'function',
    controllers,
  };
  await session.end().catch(() => undefined);
  return report;
})()`;

const DEV_MODE_HINT =
  'Vývojářský režim se zapíná v aplikaci Meta Horizon v telefonu: Zařízení → Nastavení brýlí → Vývojářský režim.';

/**
 * Cesta k `adb`: nejdřív PATH, pak obvyklá místa Android SDK a odkaz, který
 * zakládá winget (ten se do PATH dostane až v novém terminálu).
 *
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => boolean} exists
 * @returns {{ adb: string } | { error: string }}
 */
export function findAdb(env, exists) {
  const fromPath = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => dir.replace(/^"|"$/g, ''))
    .flatMap((dir) => [join(dir, 'adb.exe'), join(dir, 'adb')]);
  const local = env.LOCALAPPDATA
    ? [
        join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        join(env.LOCALAPPDATA, 'Android', 'platform-tools', 'adb.exe'),
        join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'adb.exe'),
      ]
    : [];
  const adb = [...fromPath, ...local].find((candidate) => exists(candidate));
  if (adb) return { adb };
  return {
    error: [
      'Nenašel jsem adb (Android Debug Bridge, nástroj pro spojení s brýlemi přes USB).',
      'Nainstaluj ho příkazem:',
      '',
      '  winget install Google.PlatformTools',
      '',
      'Pak otevři nový terminál a spusť skript znovu.',
    ].join('\n'),
  };
}

/**
 * Výstup `adb devices` → sériové číslo prvních brýlí, které ladění povolily.
 *
 * @param {string} stdout
 * @returns {{ serial: string } | { error: string }}
 */
export function parseDevices(stdout) {
  const devices = stdout
    .split(/\r?\n/)
    .map((line) => /^(\S+)\t+(.+?)\s*$/.exec(line))
    .filter((match) => match !== null)
    .map(([, serial, state]) => ({ serial, state }));
  const ready = devices.find((device) => device.state === 'device');
  if (ready) return { serial: ready.serial };
  if (devices.some((device) => device.state === 'unauthorized')) {
    return {
      error: [
        'Brýle jsou připojené, ale nepovolily ladění přes USB.',
        'Nasaď si je a potvrď dialog „Allow USB debugging“ (zaškrtni „Always allow from this computer“).',
        'Dialog nevidíš? Odpoj kabel a připoj ho znovu.',
        DEV_MODE_HINT,
      ].join('\n'),
    };
  }
  if (devices.length > 0) {
    const { serial, state } = devices[0];
    return { error: `Zařízení ${serial} je ve stavu „${state}“. Odpoj kabel a připoj ho znovu.` };
  }
  return {
    error: [
      'Nevidím žádné brýle.',
      `1. ${DEV_MODE_HINT}`,
      '2. Připoj Quest 2 k počítači kabelem USB-C.',
      '3. V brýlích potvrď „Allow USB debugging“.',
    ].join('\n'),
  };
}

/**
 * `adb shell` slepí argumenty do jednoho řádku pro shell v brýlích. Bez uvozovek
 * by ten shell vzal `&` v adrese jako „pusť na pozadí“ a otevřel hru bez `vrhud=1`.
 *
 * @param {string} serial
 * @param {string} [url]
 * @returns {string[]}
 */
export function openGameArgs(serial, url = GAME_URL) {
  return ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, 'com.oculus.browser'];
}

/**
 * Řádek `VrApi` → snímky za poslední sekundu (číslo před lomítkem v `FPS=72/72`),
 * jinak `null`.
 *
 * @param {string} line
 * @returns {number | null}
 */
export function parseVrApiFps(line) {
  const match = /\bFPS=(\d+)/.exec(line);
  return match ? Number(match[1]) : null;
}

/**
 * Medián a 5. percentil metodou nejbližšího pořadí (hodnota, pod kterou leží
 * nejvýš 5 % vzorků). Bez vzorků `null`, ne nula.
 *
 * @param {readonly number[]} samples
 * @returns {{ median: number, p5: number, samples: number } | null}
 */
export function summarizeFps(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p5 = sorted[Math.max(0, Math.ceil(sorted.length * 0.05) - 1)];
  return { median, p5, samples: sorted.length };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function adbRun(adb, args) {
  try {
    return execFileSync(adb, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return fail(`adb ${args.join(' ')} selhalo:\n${String(error.stderr || error.message).trim()}`);
  }
}

function waitForEnter(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    rl.question(prompt, () => {
      rl.close();
      done();
    });
  });
}

/** @returns {Promise<number[]>} */
function readFps(adb, serial, seconds) {
  // Logcat nejdřív vysype starou historii; bez vymazání by se do měření
  // dostaly řádky z doby před vstupem do VR.
  adbRun(adb, ['-s', serial, 'logcat', '-c']);
  const child = spawn(adb, ['-s', serial, 'logcat', '-s', 'VrApi'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const samples = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const fps = parseVrApiFps(line);
    if (fps !== null) samples.push(fps);
  });
  return new Promise((done) => {
    const timer = setTimeout(() => child.kill(), seconds * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      done(samples);
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Opakuje `attempt`, dokud nevrátí něco jiného než `null`, nejdéle `ms`. */
async function poll(attempt, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await attempt().catch(() => null);
    if (value !== null || Date.now() > until) return value;
    await sleep(500);
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Rychlá hra z věty na serveru počítače (synchronní koncept, žádný model) → cesta `/play/<id>`. */
async function quickGame(port) {
  const response = await fetch(`http://localhost:${String(port)}/api/play/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: 'A hamster escapes a supermarket while a giant Roomba hunts it.' }),
  });
  if (!response.ok) fail(`Server na portu ${String(port)} hru nevytvořil (${String(response.status)}). Běží build přes next start?`);
  return /** @type {{ url: string }} */ (await response.json()).url;
}

/** Stránka našeho serveru v prohlížeči brýlí, spojená přes CDP; `null`, když ji prohlížeč do 30 s neukáže. */
async function openPage(adb, serial, port) {
  adbRun(adb, cdpForwardArgs(serial));
  const page = await poll(async () => pickPage(await (await fetch(`http://localhost:${String(CDP_PORT)}/json`)).json(), port), 30_000);
  if (page === null) return null;
  console.log(`CDP: ${page.url}`);
  return cdpConnect(page.webSocketDebuggerUrl);
}

const NO_PAGE = (port) => `V prohlížeči brýlí nevidím stránku localhost:${String(port)}. Jsou brýle nasazené a prohlížeč v popředí?`;

function cleanUp(adb, serial, port) {
  adbRun(adb, ['-s', serial, 'forward', '--remove', `tcp:${String(CDP_PORT)}`]);
  adbRun(adb, ['-s', serial, 'reverse', '--remove', `tcp:${String(port)}`]);
}

/** Klepnutí na „Enter VR“, které prohlížeč bere jako gesto uživatele. Vrátí, která cesta relaci otevřela. */
async function enterVr(cdp) {
  await cdpEvaluate(cdp, PROBE_HOOK);
  const at = await poll(() => cdpEvaluate(cdp, ENTER_VR_RECT), 30_000);
  if (at === null) return 'no-button';
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
  const opened = () => cdpEvaluate(cdp, 'window.__probeSession ? true : null');
  if ((await poll(opened, 10_000)) === true) return 'cdp-mouse';
  await cdpEvaluate(cdp, `document.querySelector('[data-testid="enter-vr"]')?.click()`, { userGesture: true });
  return (await poll(opened, 10_000)) === true ? 'cdp-user-gesture' : 'failed';
}

async function probe(adb, serial, port) {
  const url = gameUrl(port, await quickGame(port));
  console.log(adbRun(adb, openGameArgs(serial, url)).trim());
  const cdp = await openPage(adb, serial, port);
  if (cdp === null) {
    // Připojené, ale nedosažitelné: zapsat, co drží popředí, ať další běh ví, proč sonda nic nezměřila.
    const foreground = parseResumedActivity(adbRun(adb, ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']));
    cleanUp(adb, serial, port);
    writeJson(CAPS_FILE, { connected: true, reached: false, measuredAt: new Date().toISOString(), foreground });
    console.log(`${NO_PAGE(port)}\nV popředí brýlí: ${String(foreground)}\nZapsáno: ${CAPS_FILE} – sonda nic nezměřila.`);
    return;
  }
  await poll(() => cdpEvaluate(cdp, `document.readyState === 'complete' ? true : null`), 30_000);
  const page = await cdpEvaluate(cdp, PROBE_PAGE);
  const enter = await enterVr(cdp);
  const session = enter === 'cdp-mouse' || enter === 'cdp-user-gesture' ? await cdpEvaluate(cdp, PROBE_SESSION) : null;
  cdp.close();
  cleanUp(adb, serial, port);
  const caps = { connected: true, reached: true, measuredAt: new Date().toISOString(), url, ...page, enterVr: enter, session };
  writeJson(CAPS_FILE, caps);
  console.log(JSON.stringify(caps, null, 2));
  console.log(`Zapsáno: ${CAPS_FILE}`);
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if ('error' in cli) {
    console.error(cli.error);
    process.exit(2);
  }
  const { port, fps: seconds } = cli;

  const found = findAdb(process.env, existsSync);
  if ('error' in found) fail(found.error);
  const { adb } = found;

  const device = parseDevices(adbRun(adb, ['devices']));
  if ('error' in device && cli.probe) {
    // Bez brýlí sonda nic neměří; soubor to řekne, ať nikdo nečte staré schopnosti jako dnešní.
    writeJson(CAPS_FILE, { connected: false });
    console.log(`${device.error}\nZapsáno: ${CAPS_FILE} – brýle nepřipojené.`);
    return;
  }
  if ('error' in device) fail(device.error);
  const { serial } = device;
  console.log(`Brýle: ${serial}`);

  adbRun(adb, ['-s', serial, 'reverse', `tcp:${String(port)}`, `tcp:${String(port)}`]);
  console.log(`Port ${String(port)} přesměrovaný: brýle vidí server počítače jako localhost:${String(port)}.`);

  if (cli.probe) {
    await probe(adb, serial, port);
    return;
  }
  const url = gameUrl(port);
  console.log(adbRun(adb, openGameArgs(serial, url)).trim());
  console.log(`Otevřeno v prohlížeči brýlí: ${url}`);
  if (cli.cdp) {
    const cdp = await openPage(adb, serial, port);
    if (cdp === null) fail(NO_PAGE(port));
    console.log(JSON.stringify(await cdpEvaluate(cdp, '({ href: location.href, title: document.title, xr: Boolean(navigator.xr) })')));
    cdp.close();
  }
  if (seconds === null) return;

  await waitForEnter('V brýlích stiskni „Enter VR“ a začni hrát. Pak v terminálu stiskni Enter, měření začne. ');
  console.log(`Měřím FPS ${String(seconds)} s…`);
  const summary = summarizeFps(await readFps(adb, serial, seconds));
  if (summary === null) {
    fail('Za celou dobu nepřišel žádný řádek VrApi s FPS. Nic jsem nezapsal. Jsou brýle nasazené a běží hra ve VR?');
  }
  writeJson(FPS_FILE, { measuredAt: new Date().toISOString(), url: gameUrl(port), seconds, ...summary });
  console.log(`Medián ${String(summary.median)} FPS, 5. percentil ${String(summary.p5)} FPS ze ${String(summary.samples)} vzorků (cíl: medián ≥ 72, 5. percentil ≥ 65).`);
  console.log(`Zapsáno: ${FPS_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
