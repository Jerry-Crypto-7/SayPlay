/**
 * Relace arkádové hry v prohlížeči (P25A T6): stav, záznam vstupů, pevný krok.
 *
 * Hodiny jen pohánějí tiky – `advance(ms)` přičte čas do akumulátoru a
 * odtiká celé kroky po 1/60 s; stav se počítá jen ze světa a vstupů, takže
 * záznam (`inputs()`) přehraný `replay` z jádra dá týž hash. Stisky mezi
 * tiky se sbírají do masky a padnou do nejbližšího tiku (hrany); osa
 * (`hold`, plošinovka P25C) platí, dokud se nezmění, a zapisuje se do
 * každého tiku, kdy je nenulová; držená tlačítka (`holdButtons`, nabíjení
 * hodu P25G) stejně. `prev` je stav před posledním krokem –
 * kreslení mezi ním a `state` interpoluje.
 */

import { ARCADE_HZ, AXIS_MAX, type ArcadeEffect, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT, UNIT, bodyBase, BODY } from '@/play/arcade/contract';
import { type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type LiveEntry, type LivePatch, acceptLive, stepLive } from '@/play/arcade/live';
import { type BotRun, runBot } from '@/play/arcade/verify';

export const TICK_MS = 1000 / ARCADE_HZ;
/** Víc času najednou (skrytá záložka, zamrzlý snímek) se zahodí – hra se nedohraje bez hráče. */
const MAX_FRAME_MS = 250;

export interface ArcadeSnapshot {
  readonly tick: number;
  readonly runState: ArcadeOutcome;
  readonly score: number;
  readonly health: number;
  /** Uběhlá část trati 0..100 (%). */
  readonly progress: number;
  readonly distanceM: number;
  /** Zbývající rány nebo hody (zásobník + záloha). */
  readonly shots: number;
  /** Sebrané předměty doplňku `+collect`. */
  readonly items: number;
}

export interface ArcadeSession {
  readonly world: ArcadeWorld;
  state(): Int32Array;
  prev(): Int32Array;
  /** Stisk do nejbližšího tiku; `axis` (nenulová) platí jen pro ten tik. */
  press(buttons: number, axis?: number): void;
  /** Držená osa −AXIS_MAX..AXIS_MAX (0 = puštěno). */
  hold(axis: number): void;
  /** Držená tlačítka (nabíjení hodu, míření šipkami) – padnou do každého tiku, dokud se nepustí (0). */
  holdButtons(buttons: number): void;
  /** Posune hodiny o `ms`; vrací podíl rozběhnutého tiku 0..1 pro interpolaci. */
  advance(ms: number): number;
  /** Podíl rozběhnutého tiku z posledního `advance` – duch (P37C T3) interpoluje stejně jako hráč. */
  alpha(): number;
  /** Čas kresby (ms) od konce běhu, za běhu 0 – hračková póza po konci dohraje oslavu a pád (P45D T22); jen obraz, nic se nehashuje. */
  endedFor(): number;
  stepOnce(): void;
  inputs(): readonly InputEvent[];
  snapshot(): ArcadeSnapshot;
  subscribe(listener: () => void): () => void;
  restart(): void;
  /** Od tiku 0 přehraje záznam a dotočí běh do konce (nebo horizontu). */
  playInputs(inputs: readonly InputEvent[], horizon: number): ArcadeSnapshot;
  /** Záznam robota ověřovače – ten, kterým hra prošla publikací. */
  botInputs(): readonly InputEvent[];
  /**
   * Pauza (P27B T3): hodiny stojí a vstupy se zahodí – do záznamu nejde nic,
   * takže záznam s pauzami je týž jako bez nich. Rozběhnutý stisk i držené
   * vstupy pauza pustí; restart ji nechá, jak byla.
   */
  pause(): void;
  resume(): void;
  paused(): boolean;
  /**
   * Ukázka „Show me how“ (P27D T3): od tiku 0 v reálném čase přehraje záznam
   * robota ověřovače. Stisky hráče se zahodí a do lidského záznamu nejde nic;
   * konec ukázky nechá stav stát, dokud ho `restart` nepustí hráči.
   */
  startDemo(): void;
  /** `null` = hraje člověk; `verified` = konec má výsledek i hash publikace (`null`, dokud běží). */
  demo(): DemoState | null;
  /** Hraje člověk: ne ukázka, ne záznam robota přehraný `playInputs` (P27D T4 – jen takový běh se počítá). */
  humanRun(): boolean;
  /** Aspoň jeden běh relace skončil (výhra nebo prohra), i když ho restart už zahodil. */
  playedOnce(): boolean;
  /**
   * Efekty pravidel z tiků, které hraje člověk (P28C T1) – pro zvuk a odezvu.
   * Ukázka ani přehrání `playInputs` posluchače nevolají; do stavu ani hashe
   * posluchač nesahá.
   */
  onEvents(listener: ArcadeEventListener): () => void;
  /**
   * Živá změna běžící hry (P29D T7) do nejbližšího tiku. Jen za hráče a jen
   * ověřená (`acceptLive`): `null` = přijato, jinak důvod pro hráče.
   */
  live(patch: LivePatch): string | null;
  /** Přijaté živé změny běhu; restart je zahodí. */
  patches(): readonly LiveEntry[];
}

/** `tick` = tik, ve kterém efekty padly (před jeho přičtením). */
export type ArcadeEventListener = (events: readonly ArcadeEffect[], tick: number) => void;

export interface DemoState {
  readonly ended: boolean;
  readonly verified: boolean | null;
}

/**
 * `waitForInput`: hodiny stojí až do prvního stisku (poletování – ptáček by
 * jinak spadl dřív, než hráč hru uvidí). První stisk padne do tiku 0, takže
 * záznam i přehrání jsou tytéž jako bez čekání.
 *
 * `swallowFirst` (načasování, rytmus, souboj – P25H, střelnice): první stisk jen pustí
 * hodiny a do záznamu nejde – ťuk v tiku 0 by u načasování byl minutím.
 * Držená osa a tlačítka hodiny nepustí, jen se nastaví.
 */
export function createArcadeSession(
  world: ArcadeWorld,
  { waitForInput = false, swallowFirst = false }: { readonly waitForInput?: boolean; readonly swallowFirst?: boolean } = {},
): ArcadeSession {
  // Program mění jen živé prodloužení času (P29D T7); restart vrací původní.
  let program = loadProgram(world, ARCADE_LIBRARY);
  // Živé změny `{tick, patch}` (P29D T7): replay je přehraje `replayLive` se stejným hashem.
  let patchLog: LiveEntry[] = [];
  let state = instantiate(world);
  let prev = Int32Array.from(state);
  let log: InputEvent[] = [];
  let pending = 0;
  let pendingAxis = 0;
  let held = 0;
  let heldButtons = 0;
  let started = !waitForInput;
  let accumulator = 0;
  let fraction = 0;
  let ended = 0;
  let halted = false;
  let cached: ArcadeSnapshot | null = null;
  // Ukázka: záznam robota, kurzor v něm a konec, proti kterému se ověří.
  let script: BotRun | null = null;
  let cursor = 0;
  let demoView: DemoState | null = null;
  // Běh dohraný `playInputs` (záznam robota přes sondu) do restartu – nehrál ho člověk.
  let replayed = false;
  // Některý běh relace už skončil (P37C T7) – restart ho nesmaže, pozvánka LiveBox na něm stojí.
  let endedOnce = false;
  const listeners = new Set<() => void>();
  const eventListeners = new Set<ArcadeEventListener>();

  const notify = (): void => {
    cached = null;
    if (script !== null && outcomeOf(state) !== 'running' && demoView?.ended !== true) {
      demoView = { ended: true, verified: outcomeOf(state) === script.outcome && hashArcade(state) === script.hash };
    }
    for (const listener of listeners) listener();
  };

  const tickOnce = (buttons: number, axis: number, record = true): void => {
    if (outcomeOf(state) !== 'running') return;
    prev.set(state);
    const tick = state[HEADER.tick] as number;
    const idle = buttons === 0 && axis === 0;
    if (record && !idle) log.push({ tick, buttons, axis });
    const input = idle ? NO_INPUT : { buttons, axis };
    const due = patchLog.filter((entry) => entry.tick === tick).map((entry) => entry.patch);
    let effects: readonly ArcadeEffect[];
    if (due.length === 0) effects = step(state, input, program);
    else {
      const run = { state, program };
      effects = stepLive(world, run, input, due);
      program = run.program;
      // Nová těla mohla stav prodloužit; `prev` (interpolace) musí mít stejnou délku.
      if (run.state !== state) {
        const grown = new Int32Array(run.state.length);
        grown.set(prev);
        prev = grown;
        state = run.state;
      }
    }
    if (effects.length > 0 && script === null && !replayed) for (const listener of eventListeners) listener(effects, tick);
  };

  /** Krok ukázky: vstup robota pro tenhle tik – týž výběr jako `playInputs`. */
  const scriptedTick = (inputs: readonly InputEvent[]): void => {
    const tick = state[HEADER.tick] as number;
    while (cursor < inputs.length && (inputs[cursor] as InputEvent).tick < tick) cursor += 1;
    const event = inputs[cursor];
    const now = event !== undefined && event.tick === tick ? event : NO_INPUT;
    tickOnce(now.buttons, now.axis, false);
  };

  /** Jeden tik ze sebraných stisků: osa stisku přebije drženou (klik = zamiř a vystřel, i když se pustí dřív, než tik padne). */
  const flush = (): void => {
    // Ukázku hraje robot: sebrané stisky hráče se nepoužijí a `restart` je zahodí.
    if (script !== null) return scriptedTick(script.inputs);
    tickOnce(pending | heldButtons, pendingAxis !== 0 ? pendingAxis : held);
    pending = 0;
    pendingAxis = 0;
  };

  /** Hodiny: odtiká celé kroky z akumulátoru; vrací podíl rozběhnutého tiku 0..1. */
  const clockAdvance = (ms: number): number => {
    if (outcomeOf(state) !== 'running') {
      ended += Math.min(Math.max(ms, 0), MAX_FRAME_MS);
      return 1;
    }
    if (!started) return 0;
    // Pauza drží rozběhnutý podíl, ať stojící snímek necukne o tik zpět.
    if (halted) return Math.min(1, accumulator / TICK_MS);
    accumulator += Math.min(Math.max(ms, 0), MAX_FRAME_MS);
    let stepped = false;
    // Epsilon: 30 × (1000/60) v plovoucí čárce je o chlup pod 500 a tik by se ztratil.
    while (accumulator >= TICK_MS - 1e-6 && outcomeOf(state) === 'running') {
      accumulator -= TICK_MS;
      flush();
      stepped = true;
    }
    if (stepped) notify();
    return Math.min(1, accumulator / TICK_MS);
  };

  const session: ArcadeSession = {
    world,
    state: () => state,
    prev: () => prev,
    press: (buttons, axis = 0) => {
      if (halted) return;
      if (!started && swallowFirst && buttons !== 0) {
        started = true;
        return;
      }
      pending |= buttons;
      if (axis !== 0) pendingAxis = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, Math.trunc(axis)));
      if (buttons !== 0) started = true;
    },
    // Se `swallowFirst` pouští hodiny jen stisk (a ten se spolkne): kdyby je pustilo
    // míření, klik na střelnici (míř + střel) by první ranou vystřelil (P28B T5).
    hold: (axis) => {
      if (halted) return;
      held = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, Math.trunc(axis)));
      if (held !== 0 && !swallowFirst) started = true;
    },
    holdButtons: (buttons) => {
      if (halted) return;
      heldButtons = buttons;
      if (buttons !== 0 && !swallowFirst) started = true;
    },
    advance: (ms) => {
      fraction = clockAdvance(ms);
      return fraction;
    },
    alpha: () => fraction,
    endedFor: () => ended,
    stepOnce: () => {
      flush();
      notify();
    },
    inputs: () => log,
    snapshot: () => {
      if (cached !== null) return cached;
      const player = bodyBase(state[HEADER.player] as number);
      const z = Math.max(0, state[player + BODY.z] as number);
      const runState = outcomeOf(state);
      cached = {
        tick: state[HEADER.tick] as number,
        runState,
        score: state[HEADER.counters + COUNTER.score] as number,
        health: state[HEADER.counters + COUNTER.health] as number,
        // Cílová páska se protne přední stěnou, ne středem – výhra je vždy celá trať.
        progress: runState === 'won' ? 100 : world.length > 0 ? Math.min(99, Math.floor((z * 100) / world.length)) : 0,
        distanceM: Math.floor(z / UNIT),
        shots: (state[HEADER.counters + COUNTER.ammo] as number) + (state[HEADER.counters + COUNTER.reserve] as number),
        items: state[HEADER.counters + COUNTER.items] as number,
      };
      return cached;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart: () => {
      if (outcomeOf(state) !== 'running') endedOnce = true;
      state = instantiate(world);
      prev = Int32Array.from(state);
      log = [];
      patchLog = [];
      program = loadProgram(world, ARCADE_LIBRARY);
      pending = 0;
      pendingAxis = 0;
      held = 0;
      heldButtons = 0;
      started = !waitForInput;
      accumulator = 0;
      fraction = 0;
      ended = 0;
      script = null;
      cursor = 0;
      demoView = null;
      replayed = false;
      notify();
    },
    playInputs: (inputs, horizon) => {
      session.restart();
      replayed = true;
      let next = 0;
      while (outcomeOf(state) === 'running' && (state[HEADER.tick] as number) < horizon) {
        const tick = state[HEADER.tick] as number;
        while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
        const event = inputs[next];
        const now = event !== undefined && event.tick === tick ? event : NO_INPUT;
        tickOnce(now.buttons, now.axis);
      }
      notify();
      return session.snapshot();
    },
    botInputs: () => runBot(world).inputs,
    pause: () => {
      if (halted) return;
      halted = true;
      pending = 0;
      pendingAxis = 0;
      held = 0;
      heldButtons = 0;
      notify();
    },
    resume: () => {
      if (!halted) return;
      halted = false;
      notify();
    },
    paused: () => halted,
    startDemo: () => {
      const bot = runBot(world);
      session.restart();
      script = bot;
      demoView = { ended: false, verified: null };
      // Ukázka nečeká na první ťuk: ten by jinak musel přijít od hráče.
      started = true;
      halted = false;
      notify();
    },
    demo: () => demoView,
    humanRun: () => script === null && !replayed,
    playedOnce: () => endedOnce || outcomeOf(state) !== 'running',
    live: (patch) => {
      if (script !== null || replayed || outcomeOf(state) !== 'running') return 'The game is not being played right now.';
      const entry: LiveEntry = { tick: state[HEADER.tick] as number, patch };
      const verdict = acceptLive(world, state, patchLog, entry);
      if (!verdict.ok) return verdict.reason;
      patchLog.push(entry);
      notify();
      return null;
    },
    patches: () => patchLog,
    onEvents: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
  return session;
}

/** Výloha vstupní stránky (P28D T7): ukázka robota hraje dokola, `pauseMs` po konci znovu. Vrací úklid. */
export function loopDemo(session: ArcadeSession, pauseMs = 1000): () => void {
  let again: ReturnType<typeof setTimeout> | undefined;
  if (session.demo() === null) session.startDemo();
  const unsubscribe = session.subscribe(() => {
    if (session.demo()?.ended === true && again === undefined) {
      again = setTimeout(() => {
        again = undefined;
        session.startDemo();
      }, pauseMs);
    }
  });
  return () => {
    clearTimeout(again);
    unsubscribe();
  };
}
