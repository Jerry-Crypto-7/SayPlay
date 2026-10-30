/**
 * Quest 2 dev skript (`scripts/quest-dev.mjs`) bez brýlí: hledání adb, výstup
 * `adb devices`, řádek VrApi a souhrn FPS. Parser, který vrátí cílovou obnovovací
 * frekvenci místo skutečných snímků, nebo souhrn, který z nuly vzorků udělá
 * 0 FPS, by vypadal jako měření – proto vzorky s padajícími snímky.
 */

import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CDP_PORT,
  ENTER_VR_RECT,
  FPS_GATE,
  GAME_URL,
  NOT_MEASURED,
  PROBE_HOOK,
  PROBE_PAGE,
  PROBE_SESSION,
  SHOTS_DIR,
  TOUR_PLAY,
  TOUR_STOP,
  belowGate,
  cdpConnect,
  cdpEvaluate,
  cdpForwardArgs,
  findAdb,
  fpsReport,
  gameUrl,
  notMeasured,
  openGameArgs,
  parseCli,
  parseDevices,
  parseGames,
  parseResumedActivity,
  parseVrApiFps,
  parseWakefulness,
  pickPage,
  publishArgs,
  screencapArgs,
  summarizeFps,
  tourRow,
} from '../quest-dev.mjs';

describe('findAdb', () => {
  const env = { PATH: ['C:\\tools', 'C:\\bin'].join(delimiter), LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const sdkAdb = join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');

  it('without adb anywhere prints the exact winget command', () => {
    const result = findAdb(env, () => false);
    expect(result).toEqual({ error: expect.stringContaining('winget install Google.PlatformTools') as unknown });
  });

  it('prefers adb on PATH over the SDK folder', () => {
    const onPath = join('C:\\bin', 'adb.exe');
    const present = new Set([onPath, sdkAdb]);
    expect(findAdb(env, (path) => present.has(path))).toEqual({ adb: onPath });
  });

  it('falls back to the Android SDK platform-tools under LOCALAPPDATA', () => {
    expect(findAdb(env, (path) => path === sdkAdb)).toEqual({ adb: sdkAdb });
  });
});

describe('parseDevices', () => {
  it('an empty device list explains developer mode and the USB debugging prompt', () => {
    const result = parseDevices('List of devices attached\r\n\r\n');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('Meta Horizon');
    expect(result.error).toContain('Allow USB debugging');
  });

  it('an unauthorized headset asks to confirm USB debugging in the headset', () => {
    const result = parseDevices('List of devices attached\n1WMHH8ABCD1234\tunauthorized\n\n');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('nepovolily ladění');
    expect(result.error).toContain('Allow USB debugging');
  });

  it('returns the authorized headset and skips daemon chatter', () => {
    const stdout = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'OFFLINE0001\toffline',
      '1WMHH8ABCD1234\tdevice',
      '',
    ].join('\r\n');
    expect(parseDevices(stdout)).toEqual({ serial: '1WMHH8ABCD1234' });
  });
});

describe('openGameArgs', () => {
  it('quotes the URL for the headset shell so `?vrhud=1` survives', () => {
    const args = openGameArgs('1WMHH8ABCD1234');
    expect(GAME_URL).toBe('http://localhost:3165/play?vrhud=1');
    expect(args[args.indexOf('-d') + 1]).toBe(`'${GAME_URL}'`);
    expect(args.at(-1)).toBe('com.oculus.browser');
  });

  it('opens a game on another port and path', () => {
    const url = gameUrl(3168, '/play/abc123');
    expect(url).toBe('http://localhost:3168/play/abc123?vrhud=1');
    const args = openGameArgs('1WMHH8ABCD1234', url);
    expect(args[args.indexOf('-d') + 1]).toBe(`'${url}'`);
  });
});

describe('parseCli', () => {
  it('defaults to port 3165, no FPS run and no CDP – the guide’s plain command', () => {
    expect(parseCli([])).toEqual({ port: 3165, fps: null, cdp: false, probe: false, tour: null, shots: SHOTS_DIR });
  });

  it('reads --port, --fps, --cdp and --probe', () => {
    expect(parseCli(['--port', '3168', '--fps', '30', '--cdp', '--probe'])).toEqual({ port: 3168, fps: 30, cdp: true, probe: true, tour: null, shots: SHOTS_DIR });
  });

  it('reads the tour of the plan – seconds per genre – and where its screenshots go', () => {
    expect(parseCli(['--port', '3168', '--cdp', '--tour', '30'])).toEqual({ port: 3168, fps: null, cdp: true, probe: false, tour: 30, shots: SHOTS_DIR });
    expect(SHOTS_DIR).toBe('D:/caches/p67/quest');
    expect(parseCli(['--cdp', '--tour', '5', '--shots', 'C:/tmp/q'])).toMatchObject({ tour: 5, shots: 'C:/tmp/q' });
  });

  it('refuses a port that is not a port, a zero FPS run, --probe without --cdp, and a tour it cannot run', () => {
    const refused = [
      ['--port', 'abc'],
      ['--port', '0'],
      ['--port', '70000'],
      ['--port', '31.5'],
      ['--fps', '0'],
      ['--probe'],
      ['--nope'],
      // Prohlídka klepe přes CDP, měří sama a chce kladný počet sekund.
      ['--tour', '30'],
      ['--cdp', '--tour', '0'],
      ['--cdp', '--tour', 'abc'],
      ['--cdp', '--tour', '30', '--probe'],
      ['--cdp', '--tour', '30', '--fps', '60'],
      ['--shots', 'C:/tmp/q'],
    ];
    for (const argv of refused) {
      const result = parseCli(argv);
      expect('error' in result, argv.join(' ')).toBe(true);
      if ('error' in result) expect(result.error).toContain('usage:');
    }
  });
});

describe('the genre tour (P67 T13)', () => {
  it('reads whether the headset is awake – an asleep headset is not touched', () => {
    const stdout = ['POWER MANAGER (dumpsys power)', '  mWakefulness=Asleep', '  mWakefulnessChanging=false'].join('\n');
    expect(parseWakefulness(stdout)).toBe('Asleep');
    expect(parseWakefulness('  mWakefulness=Awake\n')).toBe('Awake');
    expect(parseWakefulness('no power manager here')).toBeNull();
  });

  it('publishes the budget’s games on the branch server, and reads only a list of genre games back', () => {
    const args = publishArgs(3168);
    expect(args.slice(-4)).toEqual(['evals/vr/budget.mjs', '--base', 'http://127.0.0.1:3168', '--publish']);
    expect(args).toContain('--experimental-strip-types');
    const games = [
      { id: 'shooter.default', kind: 'native', url: '/play/abc123' },
      { id: 'timing.stack', kind: 'diorama', url: '/play/def456' },
    ];
    expect(parseGames(`publishing…\n${JSON.stringify(games)}\n`)).toEqual(games);
    for (const bad of ['', 'not json', '[]', JSON.stringify([{ id: 'x', kind: 'native', url: 'https://elsewhere/' }]), JSON.stringify({ games })]) expect(() => parseGames(bad), bad).toThrow();
  });

  it('takes the screenshot through exec-out, which leaves the PNG bytes alone', () => {
    expect(screencapArgs('1WMHH8ABCD1234')).toEqual(['-s', '1WMHH8ABCD1234', 'exec-out', 'screencap', '-p']);
  });

  it('a genre row keeps its per-second samples and summarizes them; no samples is null, not 0 FPS', () => {
    const base = { id: 'runner.default', kind: 'surround', url: 'http://localhost:3168/play/abc?vrhud=1', enterVr: 'cdp-mouse', runState: 'running', screenshot: null };
    // 20 sekund: jedna s propadem na 60 je právě 5 % – nejbližší pořadí ji vezme jako 5. percentil.
    const fps = [72, 72, 71, 72, 60, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72];
    expect(tourRow({ ...base, fps })).toEqual({ ...base, fps, median: 72, p5: 60, samples: 20 });
    expect(tourRow({ ...base, enterVr: 'no-button', fps: [] })).toMatchObject({ median: null, p5: null, samples: 0, fps: [] });
  });

  it('writes a measured file with the gate, or says why nothing was measured', () => {
    const row = tourRow({ id: 'whack.default', kind: 'native', url: 'u', enterVr: 'cdp-mouse', fps: [72, 72, 72], runState: 'won', screenshot: 'D:/caches/p67/quest/whack.default.png' });
    expect(fpsReport({ measuredAt: '2026-10-29T20:00:00.000Z', port: 3168, seconds: 30, tour: true, genres: [row] })).toEqual({
      connected: true,
      measuredAt: '2026-10-29T20:00:00.000Z',
      base: 'http://localhost:3168',
      seconds: 30,
      tour: true,
      gate: { median: 72, p5: 65 },
      genres: [row],
    });
    expect(FPS_GATE).toEqual({ median: 72, p5: 65 });
    const skipped = notMeasured({ checkedAt: '2026-10-29T20:00:00.000Z', reason: 'asleep', serial: '1WMHH8ABCD1234', wakefulness: 'Asleep' });
    expect(skipped).toEqual({ connected: false, note: NOT_MEASURED, checkedAt: '2026-10-29T20:00:00.000Z', reason: 'asleep', serial: '1WMHH8ABCD1234', wakefulness: 'Asleep', foreground: null });
    expect(NOT_MEASURED).toBe('neměřeno – brýle nepřipojené/nenasazené, měří se v T15');
  });

  it('a genre under the gate – median, 5th percentile, or no frames at all – is named', () => {
    const row = (id: string, median: number | null, p5: number | null, samples: number) => ({ id, median, p5, samples });
    expect(belowGate([row('ok', 72, 65, 30), row('slow', 71.5, 70, 30), row('stutter', 72, 64, 30), row('none', null, null, 0)])).toEqual(['slow', 'stutter', 'none']);
    expect(belowGate([row('edge', 72, 65, 1)])).toEqual([]);
  });

  it('the in-page robot and the stop script parse, tick by timer and end the session', () => {
    for (const script of [TOUR_PLAY, TOUR_STOP]) expect(() => new Function(`return ${script}`)).not.toThrow();
    // Okno stránky v immersive relaci snímky nedostává: robot jede na časovači, ne na requestAnimationFrame.
    expect(TOUR_PLAY).toContain('setInterval');
    expect(TOUR_PLAY).not.toContain('requestAnimationFrame');
    for (const call of ['byHand(true)', 'botWants()', 'tickByHand()']) expect(TOUR_PLAY).toContain(call);
    expect(TOUR_STOP).toContain('session.end()');
  });
});

describe('CDP without a headset', () => {
  it('forwards the browser’s DevTools socket, not a TCP port of the headset', () => {
    expect(cdpForwardArgs('1WMHH8ABCD1234')).toEqual(['-s', '1WMHH8ABCD1234', 'forward', `tcp:${String(CDP_PORT)}`, 'localabstract:chrome_devtools_remote']);
    expect(CDP_PORT).toBe(9222);
  });

  it('names the app in front of the headset, which says why the browser never showed the page', () => {
    const stdout = [
      '  Resumed activities in task display areas (from top to bottom):',
      '    ResumedActivity: ActivityRecord{e5864b1 u0 com.oculus.firsttimenux/.FirstTimeNuxExclusiveSystemDialogActivity t1316}',
      '  ResumedActivity: ActivityRecord{e5864b1 u0 com.oculus.firsttimenux/.FirstTimeNuxExclusiveSystemDialogActivity t1316}',
    ].join('\n');
    expect(parseResumedActivity(stdout)).toBe('com.oculus.firsttimenux/.FirstTimeNuxExclusiveSystemDialogActivity');
    expect(parseResumedActivity('ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n')).toBeNull();
  });

  it('picks the page of our server, not another tab, a worker or another port', () => {
    const targets = [
      { type: 'service_worker', url: 'http://localhost:3168/sw.js', webSocketDebuggerUrl: 'ws://x/sw' },
      { type: 'page', url: 'https://www.meta.com/', webSocketDebuggerUrl: 'ws://x/meta' },
      { type: 'page', url: 'http://localhost:3165/play', webSocketDebuggerUrl: 'ws://x/old' },
      { type: 'page', url: 'http://localhost:3168/play/abc?vrhud=1', webSocketDebuggerUrl: 'ws://x/ours' },
    ];
    expect(pickPage(targets, 3168)).toEqual({ url: 'http://localhost:3168/play/abc?vrhud=1', webSocketDebuggerUrl: 'ws://x/ours' });
    expect(pickPage(targets, 3169)).toBeNull();
    // Stránka bez ladicího soketu (už ji ladí jiný klient) se vybrat nedá.
    expect(pickPage([{ type: 'page', url: 'http://localhost:3168/play' }], 3168)).toBeNull();
  });

  /** Podvržený soket CDP: odpoví na každý požadavek tím, co vrátí `reply`. */
  function fakeSocket(reply: (message: { id: number; method: string; params: Record<string, unknown> }) => object) {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    class FakeWebSocket extends EventTarget {
      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(data: string) {
        const message = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
        sent.push({ method: message.method, params: message.params });
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, ...reply(message) }) })));
      }
      close() {}
    }
    return { FakeWebSocket, sent };
  }

  it('evaluates in the page, waits for promises and returns the value', async () => {
    const { FakeWebSocket, sent } = fakeSocket(() => ({ result: { result: { type: 'object', value: { immersiveVr: true } } } }));
    const cdp = await cdpConnect('ws://x/ours', { WebSocketImpl: FakeWebSocket });
    expect(await cdpEvaluate(cdp, PROBE_PAGE, { userGesture: true })).toEqual({ immersiveVr: true });
    expect(sent).toEqual([{ method: 'Runtime.evaluate', params: { expression: PROBE_PAGE, awaitPromise: true, returnByValue: true, userGesture: true } }]);
  });

  it('an exception in the page and a protocol error both reject, never a silent undefined', async () => {
    const thrown = fakeSocket(() => ({ result: { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } } }));
    const page = await cdpConnect('ws://x/ours', { WebSocketImpl: thrown.FakeWebSocket });
    await expect(cdpEvaluate(page, 'boom()')).rejects.toThrow('TypeError: boom');

    const refused = fakeSocket(() => ({ error: { code: -32601, message: "'Runtime.evaluate' wasn't found" } }));
    const protocol = await cdpConnect('ws://x/ours', { WebSocketImpl: refused.FakeWebSocket });
    await expect(cdpEvaluate(protocol, '1')).rejects.toThrow("wasn't found");
  });

  it('a page that never answers times out instead of hanging the run', async () => {
    class Silent extends EventTarget {
      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send() {}
      close() {}
    }
    const cdp = await cdpConnect('ws://x/ours', { WebSocketImpl: Silent, timeoutMs: 20 });
    await expect(cdpEvaluate(cdp, '1')).rejects.toThrow('neodpověděl');
  });

  it('the probe scripts parse as JavaScript and ask what the plan needs', () => {
    for (const script of [PROBE_PAGE, PROBE_HOOK, ENTER_VR_RECT, PROBE_SESSION]) expect(() => new Function(`return ${script}`)).not.toThrow();
    for (const asked of ['userAgent', "isSessionSupported('immersive-vr')", 'webkitSpeechRecognition', 'navigator.share', 'serviceWorker']) expect(PROBE_PAGE).toContain(asked);
    for (const asked of ['supportedFrameRates', 'hapticActuators', 'session.end()']) expect(PROBE_SESSION).toContain(asked);
  });
});

describe('parseVrApiFps', () => {
  it('reads the frames rendered, the number before the slash', () => {
    const line =
      '10-27 14:03:11.482  1873  2011 I VrApi   : FPS=72/72,Prd=45ms,Tear=0,Early=0,Stale=0,Stale2/5/10/max=0/0/0/0,VSnc=0,Lat=-1,Fov=0D,CPU4/GPU=2/3,1171/490MHz,OC=FF,TA=0/0/0,SP=N/N/N,Mem=1804MHz,Free=2043MB,PLS=0,Temp=31.0C/0.0C,TW=1.86ms,App=4.27ms,GD=0.00ms,CPU&GPU=8.41ms,LCnt=1,GPU%=0.43,CPU%=0.15(W0.19),DSF=1.00';
    expect(parseVrApiFps(line)).toBe(72);
  });

  it('a dropping frame rate reads the rendered frames, not the refresh target', () => {
    expect(parseVrApiFps('VrApi   : FPS=58/72,Prd=47ms,Tear=0,Early=0,Stale=14')).toBe(58);
  });

  it('a line without FPS is null', () => {
    expect(parseVrApiFps('--------- beginning of main')).toBeNull();
    expect(parseVrApiFps('VrApi   : vrapi_EnterVrMode()')).toBeNull();
  });
});

describe('summarizeFps', () => {
  it('median and nearest-rank 5th percentile of an unsorted sample', () => {
    const samples = Array.from({ length: 40 }, (_, i) => 40 - i);
    expect(summarizeFps(samples)).toEqual({ median: 20.5, p5: 2, samples: 40 });
  });

  it('odd count takes the middle value; one bad second sets p5 of a short run', () => {
    expect(summarizeFps([72, 72, 45, 72, 71])).toEqual({ median: 72, p5: 45, samples: 5 });
  });

  it('zero samples is null, never a fake 0 FPS', () => {
    expect(summarizeFps([])).toBeNull();
  });
});
