/**
 * P56C T13 – telefon: přechody mezi koly řetězu a FPS, proti obyčejné hře.
 *
 *   node evals/play/p56c/phone.mjs [--base http://127.0.0.1:3111] [--runs 3] [--out evals/play/p56c/phone.json]
 *
 * Nad běžícím `next start`. Publikuje jednou A (věta řetězu, dev d01) a B (obyčejná hra ze sady P32)
 * přes `POST /api/play/games {sentence}` a střídá běhy A, B, A0 (cyklus `--runs`×). Každý běh: nový kontext
 * Pixel 7 s dotykem, CPU 4× (CDP `Emulation.setCPUThrottlingRate`, jako `scripts/p32/shots.mjs`), smyčka
 * `requestAnimationFrame` v stránce zapisuje čas každého snímku.
 *
 * A: `__playShell.demo()` pustí robota kola 1 v reálném čase. Smyčka snímků čte každý snímek stav sondy
 * (`round()`, `card()`, `outcome()`, `lives()`); když karta doběhne na 0 a kolo se otevře, zavolá `demo()`
 * znovu (mimo snímek, `setTimeout(0)`) a zapíše, jak dlouho volání trvalo – `startDemo` přepočítá robota
 * kola synchronně, a to v běžné hře hráče nenastane. Konec: `outcome() !== 'running'`, 60 s, nebo kolo
 * bez pohybu déle než 15 s (zapíše se jako nález `stuck`, nic se neobchází).
 * A0 (`chain-idle`): týž řetěz bez robota – kolo 1 pustí `start()`, další kola běží sama bez stisku a
 * prohrávají. Přechody bez ceny `demo()`, tedy tak, jak je zažije hráč; řetěz končí po třetí prohře.
 * B: robot jako v `shots.mjs` na telefonu (`play-demo-start` / `play-demo-yours` / `play-again` každých
 * 500 ms) a navíc `play-pause` jako e2e `p32-look`: „Show me how“ je jen na kartě pauzy. Stejně dlouho
 * jako předchozí běh A.
 *
 * Metriky: `transitionMaxFrameMs` (A) = nejdelší interval mezi snímky v okně [začátek karty − 100 ms,
 * otevření kola + 1000 ms], přes všechny přechody; `fpsMedian` = medián počtu snímků v celých sekundách
 * během kol (A bez oken karty; B celý běh bez prvních 2 s); `longestFrameMs` za celý zapsaný úsek.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium, devices } from '@playwright/test';

const CHAIN_SENTENCE = 'a penguin mail carrier slides down icy hills dodging snowballs, then tosses letters into chimneys';
/** `firefighter` ze sady P32 zůstává jednou hrou (plošinovka); penguin, wizard, pirate a cat jsou od P56C řetězy. */
const SINGLE_SENTENCE = 'A firefighter robot sprays water on burning trees and jumps over fallen logs';
const CPU_THROTTLING = 4;
const SETTLE_MS = 1500;
const RUN_CAP_MS = 60_000;
const STUCK_MS = 15_000;
const CARD_PRE_MS = 100;
const OPEN_POST_MS = 1000;
const TRANSITION_GATE_MS = 100;
const FPS_GATE = 30;

function parseArgs(argv) {
  const options = { base: 'http://127.0.0.1:3111', runs: 3, out: 'evals/play/p56c/phone.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[++i];
    if (flag === '--base') options.base = value.replace(/\/+$/, '');
    else if (flag === '--runs') options.runs = Number(value);
    else if (flag === '--out') options.out = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return options;
}

/** Stejná volba rendereru jako `scripts/p32/shots.mjs`. */
function rendererArgs(env = process.env) {
  const mode = env.E2E_RENDERER ?? (process.platform === 'win32' && !env.CI ? 'native' : 'software');
  if (mode === 'software') return { mode, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  return { mode, args: process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11'] : [] };
}

async function publish(base, sentence) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.url !== 'string') throw new Error(`POST /api/play/games {sentence} → ${String(response.status)} ${JSON.stringify(body)}`);
  return new URL(body.url, base).pathname;
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

/** Smyčka snímků v stránce; u řetězu i stav sondy po snímcích a s `autoDemo` volání `demo()` při otevření kola. */
function installRecorder({ chain, autoDemo }) {
  const rec = { frames: [], events: [], demoCalls: [], stopped: false, lastChangeAt: performance.now() };
  let prev = null;
  const demo = (round) => {
    const at = performance.now();
    window.__playShell.demo();
    rec.demoCalls.push({ round, at, ms: performance.now() - at });
  };
  const step = (now) => {
    if (rec.stopped) return;
    rec.frames.push(now);
    const probe = window.__playShell;
    if (chain && probe) {
      const s = { round: probe.round(), card: probe.card(), outcome: probe.outcome(), lives: probe.lives() };
      if (prev === null || s.round !== prev.round || s.card > 0 !== prev.card > 0 || s.outcome !== prev.outcome || s.lives !== prev.lives) {
        rec.events.push({ t: now, round: s.round, cardOn: s.card > 0, outcome: s.outcome, lives: s.lives });
        rec.lastChangeAt = now;
        if (autoDemo && prev !== null && prev.card > 0 && s.card === 0 && s.outcome === 'running') setTimeout(() => demo(s.round), 0);
      }
      prev = s;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  window.__rec = rec;
  window.__recDemo = demo;
}

async function newPhonePage(browser) {
  const context = await browser.newContext({ ...devices['Pixel 7'], hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message.split('\n')[0]));
  return { context, page, pageErrors };
}

async function clickIfVisible(page, testId) {
  const target = page.getByTestId(testId);
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click({ timeout: 1000 }).catch(() => {});
  return true;
}

/** Intervaly mezi snímky jako `{ start, end, ms }`. */
const intervalsOf = (frames) => frames.slice(1).map((end, i) => ({ start: frames[i], end, ms: end - frames[i] }));

/** Snímky v celých sekundách [from, to). */
function secondBins(frames, from, to) {
  const bins = [];
  for (let s = from; s + 1000 <= to; s += 1000) bins.push(frames.filter((t) => t >= s && t < s + 1000).length);
  return bins;
}

const longFrames = (intervals, origin) => intervals.filter((i) => i.ms > 50).map((i) => ({ atMs: Math.round(i.start - origin), ms: round1(i.ms) }));

async function runChain(browser, base, path, index, mode) {
  const run = { kind: mode === 'demo' ? 'chain' : 'chain-idle', index, path, durationMs: null, rounds: null, outcome: null, lives: null, transitions: [], roundFps: [], fpsBins: [], fpsMedian: null, longestFrameMs: null, transitionMaxFrameMs: null, demoCalls: [], longFrames: [], stuck: null, pageErrors: [], error: null };
  const { context, page, pageErrors } = await newPhonePage(browser);
  try {
    await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 90_000 });
    await page.locator('main[data-chain-round]').waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__playShell?.demo === 'function', undefined, { timeout: 60_000 });
    run.rounds = Number((await page.getByTestId('hud-counter-round').textContent({ timeout: 5000 }).catch(() => '')).split('/').at(-1)) || null;
    await page.waitForTimeout(SETTLE_MS);
    await page.waitForFunction(() => window.__playShell.card() === 0, undefined, { timeout: 30_000 });
    await page.evaluate(installRecorder, { chain: true, autoDemo: mode === 'demo' });
    const startedAt = await page.evaluate((demo) => {
      const at = performance.now();
      if (demo) window.__recDemo(0);
      else window.__playShell.start();
      return at;
    }, mode === 'demo');
    const capAt = Date.now() + RUN_CAP_MS;
    for (;;) {
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({ now: performance.now(), last: window.__rec.lastChangeAt, outcome: window.__playShell.outcome(), round: window.__playShell.round(), card: window.__playShell.card() }));
      if (state.outcome !== 'running') break;
      if (state.now - state.last > STUCK_MS) {
        run.stuck = { round: state.round + 1, card: state.card, stillForMs: Math.round(state.now - state.last) };
        break;
      }
      if (Date.now() > capAt) {
        run.error = `still running after ${String(RUN_CAP_MS)} ms (round ${String(state.round + 1)})`;
        break;
      }
    }
    // Ještě chvíli snímků po konci, ať poslední okno přechodu není useknuté.
    await page.waitForTimeout(300);
    const rec = await page.evaluate(() => {
      window.__rec.stopped = true;
      return { frames: window.__rec.frames, events: window.__rec.events, demoCalls: window.__rec.demoCalls, outcome: window.__playShell.outcome(), lives: window.__playShell.lives() };
    });
    run.outcome = rec.outcome;
    run.lives = rec.lives;
    const frames = rec.frames.filter((t) => t >= startedAt);
    const intervals = intervalsOf(frames);
    const endedAt = rec.events.find((e) => e.outcome !== 'running')?.t ?? frames.at(-1);
    run.durationMs = Math.round(endedAt - startedAt);
    run.demoCalls = rec.demoCalls.map((d) => ({ round: d.round + 1, atMs: Math.round(d.at - startedAt), ms: round1(d.ms) }));

    // Kolo k hraje od otevření (kolo 1: volání demo) do začátku další karty nebo konce řetězu.
    const segments = [{ round: 1, from: startedAt, to: null }];
    let cardStart = null;
    for (const event of rec.events) {
      if (event.t < startedAt) continue;
      const open = segments.at(-1);
      if (event.cardOn && cardStart === null) {
        if (open.to === null) open.to = event.t;
        cardStart = event.t;
      } else if (!event.cardOn && cardStart !== null && event.outcome === 'running') {
        const openAt = event.t;
        const from = cardStart - CARD_PRE_MS;
        const to = openAt + OPEN_POST_MS;
        const inWindow = intervals.filter((i) => i.end >= from && i.start <= to);
        const demoCall = rec.demoCalls.find((d) => d.round === event.round);
        const hasDemo = (i) => demoCall !== undefined && demoCall.at >= i.start && demoCall.at <= i.end;
        const worst = inWindow.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null);
        run.transitions.push({
          toRound: event.round + 1,
          cardStartMs: Math.round(cardStart - startedAt),
          roundOpenMs: Math.round(openAt - startedAt),
          cardMs: Math.round(openAt - cardStart),
          maxFrameMs: round1(worst?.ms ?? null),
          maxFrameAtMs: worst ? Math.round(worst.start - startedAt) : null,
          maxFrameHasDemoCall: worst ? hasDemo(worst) : false,
          maxFrameMsWithoutDemoCall: round1(Math.max(0, ...inWindow.filter((i) => !hasDemo(i)).map((i) => i.ms))),
          demoCallMs: round1(demoCall?.ms ?? null),
        });
        segments.push({ round: event.round + 1, from: openAt, to: null });
        cardStart = null;
      } else if (event.outcome !== 'running' && segments.at(-1).to === null) segments.at(-1).to = event.t;
    }
    if (segments.at(-1).to === null) segments.at(-1).to = endedAt;
    for (const segment of segments) {
      const bins = secondBins(frames, segment.from, segment.to);
      run.roundFps.push({ round: segment.round, playedMs: Math.round(segment.to - segment.from), bins, median: median(bins) });
      run.fpsBins.push(...bins);
    }
    run.fpsMedian = median(run.fpsBins);
    run.transitionMaxFrameMs = run.transitions.length === 0 ? null : Math.max(...run.transitions.map((t) => t.maxFrameMs));
    run.longestFrameMs = round1(Math.max(...intervals.filter((i) => i.start <= endedAt).map((i) => i.ms)));
    run.longFrames = longFrames(intervals, startedAt);
  } catch (error) {
    run.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  } finally {
    run.pageErrors = pageErrors;
    await context.close();
  }
  return run;
}

async function runSingle(browser, base, path, index, durationMs) {
  const run = { kind: 'single', index, path, durationMs, isChain: null, botStarts: 0, clicks: 0, fpsBins: [], fpsMedian: null, longestFrameMs: null, longFrames: [], pageErrors: [], error: null };
  const { context, page, pageErrors } = await newPhonePage(browser);
  try {
    await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 90_000 });
    await page.getByTestId('arcade-stage').first().waitFor({ timeout: 60_000 });
    run.isChain = (await page.locator('main[data-chain-round]').count()) > 0;
    if (run.isChain) throw new Error('B published as a chain (main[data-chain-round]), not a single game');
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(installRecorder, { chain: false, autoDemo: false });
    const startedAt = await page.evaluate(() => performance.now());
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
      if (await clickIfVisible(page, 'play-demo-start')) run.botStarts += 1;
      else if ((await clickIfVisible(page, 'play-demo-yours')) || (await clickIfVisible(page, 'play-again')) || (await clickIfVisible(page, 'play-pause'))) run.clicks += 1;
      await page.waitForTimeout(500);
    }
    const frames = (
      await page.evaluate(() => {
        window.__rec.stopped = true;
        return window.__rec.frames;
      })
    ).filter((t) => t >= startedAt);
    const intervals = intervalsOf(frames);
    run.fpsBins = secondBins(frames, startedAt + 2000, frames.at(-1));
    run.fpsMedian = median(run.fpsBins);
    run.longestFrameMs = round1(Math.max(...intervals.map((i) => i.ms)));
    run.longFrames = longFrames(intervals, startedAt);
  } catch (error) {
    run.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  } finally {
    run.pageErrors = pageErrors;
    await context.close();
  }
  return run;
}

const options = parseArgs(process.argv.slice(2));
const renderer = rendererArgs();
const chainPath = await publish(options.base, CHAIN_SENTENCE);
const singlePath = await publish(options.base, SINGLE_SENTENCE);
const browser = await chromium.launch({ args: renderer.args });
const runs = [];
try {
  const logChain = (label, a) =>
    process.stderr.write(`[phone] ${label}: ${String(a.outcome)} in ${String(a.durationMs)} ms, transition max ${String(a.transitionMaxFrameMs)} ms, fps ${String(a.fpsMedian)}, longest ${String(a.longestFrameMs)} ms${a.stuck ? ` STUCK ${JSON.stringify(a.stuck)}` : ''}${a.error ? ` ERROR ${a.error}` : ''}\n`);
  for (let i = 1; i <= options.runs; i += 1) {
    const a = await runChain(browser, options.base, chainPath, i, 'demo');
    runs.push(a);
    logChain(`A${String(i)}`, a);
    const b = await runSingle(browser, options.base, singlePath, i, a.durationMs ?? 30_000);
    runs.push(b);
    process.stderr.write(`[phone] B${String(i)}: fps ${String(b.fpsMedian)}, longest ${String(b.longestFrameMs)} ms, bot starts ${String(b.botStarts)}, other clicks ${String(b.clicks)}${b.error ? ` ERROR ${b.error}` : ''}\n`);
    const idle = await runChain(browser, options.base, chainPath, i, 'idle');
    runs.push(idle);
    logChain(`A0-${String(i)}`, idle);
  }
} finally {
  await browser.close();
}

/** Souhrn přechodů a FPS přes běhy jednoho druhu řetězu. */
function chainSummary(list) {
  const maxes = list.flatMap((r) => r.transitions.map((t) => t.maxFrameMs));
  return {
    transitions: maxes.length,
    transitionMaxFrameMsMedian: round1(median(maxes)),
    transitionMaxFrameMsWorst: maxes.length === 0 ? null : Math.max(...maxes),
    transitionMaxFrameMsWorstWithoutDemoCall: maxes.length === 0 ? null : round1(Math.max(...list.flatMap((r) => r.transitions.map((t) => t.maxFrameMsWithoutDemoCall)))),
    fpsMedian: median(list.flatMap((r) => r.fpsBins)),
    longestFrameMsWorst: round1(Math.max(...list.map((r) => r.longestFrameMs ?? 0))),
    stuck: list.filter((r) => r.stuck !== null).map((r) => ({ index: r.index, ...r.stuck })),
    errors: list.filter((r) => r.error !== null).map((r) => ({ index: r.index, error: r.error })),
  };
}

const chainRuns = runs.filter((r) => r.kind === 'chain');
const idleRuns = runs.filter((r) => r.kind === 'chain-idle');
const singleRuns = runs.filter((r) => r.kind === 'single');
const chain = chainSummary(chainRuns);
const chainIdle = chainSummary(idleRuns);
const worst = chain.transitionMaxFrameMsWorst;
const chainFps = chain.fpsMedian;
const result = {
  measuredAt: new Date().toISOString(),
  device: 'Pixel 7 emulated, CPU 4x',
  renderer: renderer.mode,
  server: `${options.base} (next start, worktree HEAD)`,
  sentences: { chain: { text: CHAIN_SENTENCE, path: chainPath }, single: { text: SINGLE_SENTENCE, path: singlePath } },
  method: {
    order: 'A (chain + round bot), B (single game + bot), A0 (chain, no bot) interleaved; one new browser context per run',
    transitionWindow: `[card start - ${String(CARD_PRE_MS)} ms, round open + ${String(OPEN_POST_MS)} ms]`,
    fps: 'frames per whole second; chain = round time only (cards excluded), single = whole run minus first 2 s; summary median pools every second of every run',
    demoCall: 'chain rounds 2+ get __playShell.demo() via setTimeout(0) on the first frame the card reads 0; demoCallMs = how long that synchronous call (startDemo re-runs the round bot) blocked the main thread – a cost a real player does not pay',
  },
  runs,
  summary: {
    chain,
    chainIdle,
    single: {
      fpsMedian: median(singleRuns.flatMap((r) => r.fpsBins)),
      longestFrameMsWorst: round1(Math.max(...singleRuns.map((r) => r.longestFrameMs ?? 0))),
      errors: singleRuns.filter((r) => r.error !== null).map((r) => ({ index: r.index, error: r.error })),
    },
    gate: {
      transitionMaxFrameMs: `<= ${String(TRANSITION_GATE_MS)}`,
      chainFpsMedian: `>= ${String(FPS_GATE)}`,
      pass: worst !== null && chainFps !== null && worst <= TRANSITION_GATE_MS && chainFps >= FPS_GATE,
      /** Táž brána nad během A0 bez robota: přechody bez ceny `demo()`. FPS kol bez robota nic neříká (kolo se nehraje). */
      transitionPassWithoutBot: chainIdle.transitionMaxFrameMsWorst !== null && chainIdle.transitionMaxFrameMsWorst <= TRANSITION_GATE_MS,
    },
  },
};
mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
process.stderr.write(`[phone] ${JSON.stringify(result.summary)}\n`);
