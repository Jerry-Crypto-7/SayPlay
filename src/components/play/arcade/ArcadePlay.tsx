'use client';

/**
 * Arkádová hra na `/play/[id]` (P25A T6, P25C T6): plátno, HUD, konec hry.
 *
 * Rodokmen, „How it works“, banner vylepšení a obrazovka po hře jsou tytéž
 * komponenty jako u mřížky; jiné je jen plátno a HUD. Sonda
 * `window.__playShell` má tvar mřížkové – `playWitness` tu přehraje záznam
 * robota ověřovače od tiku 0, tedy přesně běh, kterým hra prošla publikací.
 */

import dynamic from 'next/dynamic';
import { type CSSProperties, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeRole, type ArcadeWorld, BODY, FLAG, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { lookOf, sceneLook } from '@/play/arcade/look';
import { chaserModel, enemyModel, heroModel, propModels } from '@/play/arcade/models';
import { holdUntilRapier, loadRapier, prefetchRapier, rapierIfLoaded } from '@/play/arcade/physics/world';
import { installSoundControls, jumped, playMusic, playNarration, playSfx, presetsFor, setSoundLook } from '@/play/audio';
import { musicFor, narrationUrl } from '@/play/audio/library';
import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { HowItWorks } from '../HowItWorks';
import { loopEvent, loopImpression } from '../loop-client';
import { FirstPrompt } from '../FirstPrompt';
import { MoreGames } from '../MoreGames';
import { BuildingScreen, Button, CHANGE_LABEL, GameHud, type HudCounter, Icon, PauseCard, objectiveShown, useHudKeys } from '../ui';
import { secondsOf, timerLeft } from '../timer';
import type { LabFacts, ReadFacts } from '../lab';
import { AboutButton, SentenceRead } from '../SentenceRead';
import { type LivePublish, ShareButton } from '../ShareButton';
import { Lineage } from '../Lineage';
import { MuteButton } from '../MuteButton';
import { PostRun } from '../PostRun';
import { RemixReadyChip, useRemixJob } from '../RemixBox';
import { UpgradeBanner } from '../UpgradeBanner';

import { type Clip, startClip } from './clip';
import { publishLive } from './live-share';
import { pauseWhenAway } from './focus';
import { isTyping } from './input';
import { LiveBox, enterOpensLiveBox } from './LiveBox';
import { holdUntilTouch, wakesGame } from './ready-gate';
import { Weather } from './Weather';
import { createArcadeSession, type ArcadeSession, type ArcadeSnapshot } from './session';

// WebGL kontext na serveru není – stejně jako mřížkové plátno. `memo`: HUD se překresluje
// každý tik, plátno ne – scéna čte relaci sama v `useFrame` (P28E-R1: na emulovaném
// telefonu srovnání stovek těl runneru 20× za sekundu bralo většinu snímku).
// Než kód scény dorazí, stojí nad oblohou sady (P32D T6) kroky stavby na papírové kartě (P34 T4); název nese HUD.
const ArcadeStage = memo(dynamic(() => import('./ArcadeStage'), { ssr: false, loading: () => <BuildingScreen /> }));
// Chunky three.js stahovat už při načtení modulu, ne až po hydrataci: `dynamic` začne
// až při prvním renderu a do té doby síť stojí (P28E T5, mezera ~0,25 s na telefonu).
if (typeof window !== 'undefined') void import('./ArcadeStage');


/** Střelba a hod nemají trať: místo metrů ukazují zbývající rány. */
const aiming = (spec: GameSpecV1): boolean => spec.control === 'shooter' || spec.control === 'throw';

/** Co hra počítá: mince u běžce a plošinovky, turba v závodě, snědené v aréně, jinak body. */
const scoreUnit = (spec: GameSpecV1): string =>
  spec.control === 'runner' || spec.control === 'platform'
    ? 'coins'
    : spec.control === 'steer'
      ? 'turbos'
      : spec.control === 'move_free'
        ? 'eaten'
        : aiming(spec)
          ? 'hits'
          : 'points';

// `z` hráče je u načasování, rytmu a souboje počítadlo úkolů, ne dráha (P25H).
const COUNT_UNIT: Readonly<Record<string, string>> = { timing: 'rounds', rhythm: 'notes', duel: 'hits' };

/** Aréna ukazuje uběhlé sekundy, střelba a hod zbývající rány, P25H splněné úkoly, jinak metry. */
const progressLabel = (spec: GameSpecV1, snapshot: ArcadeSnapshot): string =>
  spec.control === 'move_free'
    ? `${Math.floor(snapshot.tick / ARCADE_HZ)} s`
    : aiming(spec)
      ? `${snapshot.shots} ${spec.control === 'throw' ? 'throws' : 'shots'} left`
      : `${snapshot.distanceM} ${COUNT_UNIT[spec.control ?? ''] ?? 'm'}`;

/** Hodiny stojí do prvního ťuku; u P25H ovládání ten ťuk jen spouští hru. */
const TAP_TO_START = new Set(['flap', 'shooter', 'timing', 'rhythm', 'duel']);

/** Otřes a rajčatový okraj pilulky, když hráče chytí (kit: ≤ 6 px na 200 ms). */
const CAUGHT_MS = 200;

/** Sekundy časového limitu (`time_limit`) nebo přežití (`survive_time`) světa; `null` = hra čas neměří. */
function limitOf(world: ArcadeWorld): number | null {
  const seconds = world.rules.find((rule) => rule.id === 'time_limit' || rule.id === 'survive_time')?.params.seconds;
  return typeof seconds === 'number' ? seconds : null;
}

/**
 * HUD arkády podle kitu (P34 T5, dřív tenký pruh P33 T12). Pilulka postupu
 * jen se skutečnými čísly: sebrané předměty doplňku `+collect` proti potřebě
 * jako vejce, zbývající rány, náboje a životy – hra bez nich ukáže jen
 * časovač. Časovač odpočítává, má-li svět limit (i prodloužený živou změnou,
 * `bonus`). Celý text postupu, který dřív nesl pruh, dostane čtečka; popisky
 * počítadel jdou do `data-testid` (`hud-counter-…`, seznam `e2e/hud-labels.ts`).
 */
function ArcadeHud({
  spec,
  world,
  snapshot,
  heading,
  bonus,
  paused,
  caught,
  onPause,
  bottom,
  children,
}: {
  readonly spec: GameSpecV1;
  readonly world: ArcadeWorld;
  readonly snapshot: ArcadeSnapshot;
  readonly heading: 'h1' | 'h2';
  readonly bonus: number;
  readonly paused: boolean;
  readonly caught: boolean;
  readonly onPause?: () => void;
  readonly bottom?: ReactNode;
  readonly children?: ReactNode;
}) {
  const hasLives = spec.mechanics.some((m) => m.id === 'health') || spec.addons?.includes('lives') === true;
  const lives = hasLives ? ` · ${snapshot.health} lives` : '';
  const clock = timerLeft(spec, Math.floor(snapshot.tick / ARCADE_HZ));
  const need = Number(world.rules.find((rule) => rule.id === 'finish_collected')?.params.need);
  const counters: HudCounter[] = [];
  if (aiming(spec)) counters.push({ label: 'shots', count: snapshot.shots, text: `${snapshot.shots} ${spec.control === 'throw' ? 'throws' : 'shots'} left` });
  if (world.rules.some((rule) => rule.id === 'blaster')) counters.push({ label: 'ammo', count: snapshot.shots, text: `${snapshot.shots} ammo` });
  if (hasLives) counters.push({ label: 'lives', count: snapshot.health, text: String(snapshot.health), icon: 'heart' });
  const limit = limitOf(world);
  const elapsed = snapshot.tick / ARCADE_HZ;
  return (
    <GameHud
      title={spec.title}
      heading={heading}
      goalLine={spec.tutorial.goalLine}
      goal={Number.isFinite(need) && need > 0 ? { label: 'collected', count: snapshot.items, need } : null}
      counters={counters}
      clock={limit === null ? { seconds: elapsed, countdown: false } : { seconds: limit + bonus - elapsed, countdown: true }}
      objective={snapshot.runState === 'running' && objectiveShown(snapshot.tick, ARCADE_HZ, paused)}
      caught={caught}
      onPause={onPause}
      status={
        <p className="play-sr-only">
          <span data-testid="play-progress" data-progress={snapshot.progress}>
            {/* Aréna nemá trať, procento by stálo na nule. */}
            {spec.control === 'move_free' ? '' : `${snapshot.progress}% · `}
            {snapshot.score} {scoreUnit(spec)}
            {lives}
            {clock === null ? '' : ` · ${clock}`}
          </span>{' '}
          <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick}>
            {progressLabel(spec, snapshot)}
          </span>
        </p>
      }
      bottom={bottom}
    >
      {children}
    </GameHud>
  );
}

export interface ArcadePlayProps {
  readonly versionId: string;
  readonly spec: GameSpecV1;
  readonly arcade: ArcadeWorld;
  readonly lineage: readonly GameVersion[];
  readonly remixes: number;
  readonly aiVersion?: boolean;
  /** Feed (P27B T4) je nemá – počítají se na serveru z registru – a hraje bez nich. */
  readonly lab?: LabFacts;
  readonly read?: ReadFacts;
  readonly upgrade: string | null;
  /** Hra na obrazovce feedu; `false` ji pozastaví (P27B T3). */
  readonly active?: boolean;
  /** Ukázková hra vstupní stránky (P28D T7) není v úložišti: bez sdílení, remixu a událostí smyčky. */
  readonly offline?: boolean;
  /** Hra ve feedu (P33 T12): další hru nabízí listování feedu, sloupec akcí nemá „More“. */
  readonly inFeed?: boolean;
}

const END_PAUSE_MS = 600;

/**
 * Je Rapier pro tenhle svět načtený (P29A T13)? Jádro je synchronní a bez něj
 * by první tik hry s fyzikálními tělesy spadl. Hra bez fyziky je připravená
 * hned a modul vůbec nestáhne. Server i hydratace hlásí „nenačtený“ – server
 * má Rapier načtený vlastní a jinak by se dva první rendery rozešly.
 */
export function usePhysicsReady(world: ArcadeWorld): boolean {
  const needs = useMemo(() => worldHasPhysics(world), [world]);
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!needs) return () => {};
      let live = true;
      loadRapier().then(
        () => live && changed(),
        () => undefined,
      );
      return () => {
        live = false;
      };
    },
    [needs],
  );
  return useSyncExternalStore(subscribe, () => !needs || rapierIfLoaded() !== null, () => !needs);
}

/**
 * Stránka hry ví o fyzice ze světa dřív, než se vykreslí hra (P32D T4):
 * stahování Rapieru začne už v renderu stránky, souběžně se scénou.
 */
export function PrefetchPhysics({ needed }: { readonly needed: boolean }): null {
  if (typeof window !== 'undefined') prefetchRapier(needed);
  return null;
}

/**
 * Plátno a HUD hned, i když Rapier ještě dotéká (P32D T4): hodiny relace do
 * jeho načtení stojí na tiku 0 (`holdUntilRapier`) a ukázka robota i živá
 * změna, které jádrem krokují samy, se nabídnou až s ním.
 */
export function ArcadePlay(props: ArcadePlayProps) {
  const physicsReady = usePhysicsReady(props.arcade);
  return <ArcadePlayGame {...props} physicsReady={physicsReady} />;
}

/** Živá těla role ve stavu – sonda e2e (T9). */
function aliveOf(state: ArrayLike<number>, role: ArcadeRole): number {
  let alive = 0;
  for (let i = 0; i < state[HEADER.bodyCount]; i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === ROLE[role] && (state[base + BODY.flags] & FLAG.alive) !== 0) alive += 1;
  }
  return alive;
}

/** Odklad publikace po poslední živé změně – věty jdou často po dvou a každá by jinak vyrobila verzi. */
const LIVE_PUBLISH_DELAY_MS = 800;

/**
 * Verze s živými změnami se publikuje dopředu (R4), ne až po stisku Share:
 * nabídka sdílení chce čerstvé gesto. Každá nová změna publikaci zruší a
 * pustí znovu nad všemi; `undefined` = běh žádnou nemá.
 */
function useLivePublish(versionId: string, spec: GameSpecV1, world: ArcadeWorld, session: ArcadeSession, enabled: boolean): LivePublish | undefined {
  const count = useSyncExternalStore(session.subscribe, () => session.patches().length, () => 0);
  const [done, setDone] = useState<{ readonly count: number; readonly live: LivePublish } | null>(null);
  useEffect(() => {
    if (!enabled || count === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const settle = (live: LivePublish) => {
        if (!cancelled) setDone({ count, live });
      };
      publishLive(
        versionId,
        spec,
        world,
        session.patches().map((entry) => entry.patch),
      ).then(
        (share) => settle({ state: 'ready', share }),
        () => settle({ state: 'failed' }),
      );
    }, LIVE_PUBLISH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [versionId, spec, world, session, enabled, count]);
  if (count === 0) return undefined;
  return done?.count === count ? done.live : { state: 'pending' };
}

function ArcadePlayGame({
  versionId,
  spec,
  arcade,
  lineage,
  remixes,
  aiVersion = false,
  lab,
  read,
  upgrade,
  active = true,
  offline = false,
  inFeed = false,
  physicsReady,
}: ArcadePlayProps & { readonly physicsReady: boolean }) {
  const [liveOpen, setLiveOpen] = useState(false);
  // Každá hra čeká na první dotek (P33 T11, `ready-gate.ts`): runner by jinak prohrál
  // dřív, než hráč pochopí ovládání. Poletování, střelnice a hry na čas navíc čekají
  // v relaci na první stisk a `swallowFirst` ten spouštěcí ťuk nezapíše – u načasování
  // by to byl rovnou minutý pokus (u poletování je to první mávnutí).
  const [session] = useState(() => {
    const control = baseControlOf(arcade.control).id;
    const created = holdUntilTouch(createArcadeSession(arcade, { waitForInput: TAP_TO_START.has(control), swallowFirst: control !== 'flap' }));
    return worldHasPhysics(arcade) ? holdUntilRapier(created) : created;
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const cast = useMemo(() => ({ player: heroModel(spec), enemy: enemyModel(spec), chaser: chaserModel(spec), props: propModels(spec) }), [spec]);
  const running = snapshot.runState === 'running';
  const paused = useSyncExternalStore(session.subscribe, session.paused, session.paused);
  const demo = useSyncExternalStore(session.subscribe, session.demo, session.demo);
  const remix = useRemixJob(versionId, !running && demo === null);
  const live = useLivePublish(versionId, spec, arcade, session, !offline);
  // Živá změna (P29D T9) jen v běžící hře hráče; s koncem běhu se pole zavře, ať se v další nevynoří samo.
  const canChange = running && active && demo === null && physicsReady;
  useEffect(() => {
    if (!canChange) setLiveOpen(false);
  }, [canChange]);
  // Konec má váhu (P28C T3): výsledek až END_PAUSE_MS po výhře či prohře – mezitím doběhne klip pádu nebo oslavy a zazní zvuk.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (running) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), END_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [running]);

  // Klip běhu (P29D T1): nahrává se od startu běhu hráče, po konci ještě dojezd plátna.
  // Ukázka robota klip nemá; plátno se načítá dynamicky, proto se hledá při každém tiku, než je.
  const shell = useRef<HTMLElement | null>(null);
  const [clip, setClip] = useState<Blob | null>(null);
  useEffect(() => {
    if (offline || !active) return;
    let recording: Clip | null = null;
    let tried = false;
    let wasRunning = false;
    let gone = false;
    const sync = (): void => {
      const nowRunning = session.snapshot().runState === 'running' && session.demo() === null;
      if (nowRunning && !wasRunning) {
        recording?.cancel();
        recording = null;
        tried = false;
        setClip(null);
      }
      if (nowRunning && !tried) {
        const canvas = shell.current?.querySelector<HTMLCanvasElement>('[data-testid="arcade-stage"] canvas');
        if (canvas) {
          tried = true;
          recording = startClip(canvas);
        }
      }
      if (!nowRunning && wasRunning && recording !== null) {
        const ended = recording;
        recording = null;
        if (session.demo() !== null) ended.cancel();
        else void ended.finish().then((blob) => !gone && setClip(blob));
      }
      wasRunning = nowRunning;
    };
    sync();
    const unsubscribe = session.subscribe(sync);
    return () => {
      gone = true;
      unsubscribe();
      recording?.cancel();
    };
  }, [active, offline, session]);

  // Pauza podle kitu (P34 T5): kartu pauzy ukáže pauza hráče (tlačítko, Space, Esc) a pauza
  // rozehrané hry, když hráč odešel (záložka, okno, feed). Hra, která ještě čeká na první
  // dotek, kartu po odchodu nedostane – výzvu „Tap to start“ pustí ťuk jako dřív. Dokud karta
  // (nebo list „About“ nad ní) visí, hru pustí jen karta: Resume, Space, Esc, klepnutí mimo;
  // jinak by ji pustil každý stisk (`focus.ts`), i Tab, kterým hráč po kartě chodí.
  const [aboutOpen, setAboutOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!paused) setAsked(false);
  }, [paused]);
  const pauseGame = useCallback(() => {
    setAsked(true);
    session.pause();
  }, [session]);
  const menu = running && active && demo === null;
  const holdsPause = menu && paused && (asked || snapshot.tick > 0);
  const cardShown = holdsPause && !aboutOpen;
  const holding = useRef(false);
  useEffect(() => {
    holding.current = holdsPause;
  });

  // Pauza mimo obrazovku feedu, při skryté záložce a oknu bez fokusu (`focus.ts`).
  // Rytmus nepípá, když tiky stojí.
  useEffect(() => {
    if (!active) {
      session.pause();
      return;
    }
    return pauseWhenAway(
      {
        pause: session.pause,
        paused: session.paused,
        resume: () => {
          if (!holding.current) session.resume();
        },
      },
      window,
      document,
    );
  }, [active, session]);

  // Výloha vstupní stránky (P28D T7): dokud se hráč nedotkne, hraje dokola robot ověřovače –
  // bez něj runner do tří sekund prohraje a první obrazovka ukáže „You lost“. První stisk
  // nebo ťuk na scénu výlohu ukončí v zachytávací fázi, takže ten stisk už padne do hry hráče.
  const [attract, setAttract] = useState(offline);
  useEffect(() => {
    if (!attract || !active || !physicsReady) return;
    let again: ReturnType<typeof setTimeout> | undefined;
    if (session.demo() === null) session.startDemo();
    const unsubscribe = session.subscribe(() => {
      if (session.demo()?.ended === true && again === undefined) {
        again = setTimeout(() => {
          again = undefined;
          session.startDemo();
        }, 1000);
      }
    });
    // Restart hodiny znovu zastaví; tenhle dotek je první vstup hráče, proto je hned pustí.
    const take = () => {
      setAttract(false);
      session.restart();
      session.begin();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="arcade-stage"]') !== null) take();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!event.repeat && !isTyping(event.target)) take();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(again);
      unsubscribe();
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [attract, active, physicsReady, session]);

  // První dotek (P33 T11): ťuk na scénu nebo klávesa pustí hodiny v zachytávací fázi,
  // takže tentýž stisk padne do tiku 0. Tlačítka mimo scénu (zvuk, info, Play again) ne.
  useEffect(() => {
    if (!active) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="arcade-stage"]') !== null) session.begin();
    };
    const onKey = (event: KeyboardEvent) => {
      if (wakesGame(event)) session.begin();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active, session]);

  // Události smyčky (P27D T4): zobrazení, první vstup a konec běhu – jen za člověka.
  useEffect(() => {
    if (active && !offline) loopImpression(versionId);
  }, [active, offline, versionId]);
  useEffect(() => {
    if (offline) return;
    let reported = false;
    return session.subscribe(() => {
      if (!session.humanRun()) return;
      const now = session.snapshot();
      if (now.runState === 'running') reported = false;
      if (session.inputs().length > 0) loopEvent('first_input', versionId);
      if (now.runState !== 'running' && !reported) {
        reported = true;
        loopEvent(now.runState === 'won' ? 'win' : 'lose', versionId);
      }
    });
  }, [offline, session, versionId]);

  // Sonda času do ovladatelné hry (P32D T2): první tik, ve kterém jádro zpracovalo
  // skutečný vstup hráče, a čas té chvíle na `arcade-stage`. Harness
  // `scripts/p32/shots.mjs` měří od kliknutí právě k ní – první snímek plátna
  // ještě neznamená, že hra poslouchá (Rapier, spolknutý první stisk).
  useEffect(() => {
    let done = false;
    return session.subscribe(() => {
      if (done || !session.humanRun()) return;
      const first = session.inputs()[0];
      const stage = shell.current?.querySelector('[data-testid="arcade-stage"]');
      if (first === undefined || !stage) return;
      done = true;
      stage.setAttribute('data-input-tick', String(first.tick));
      stage.setAttribute('data-input-at', String(Date.now()));
    });
  }, [session]);

  // Zvuk (P28C T2): efekty pravidel z tiků hráče a skok z rychlosti vzhůru – mimo stav.
  useEffect(() => installSoundControls(), []);
  // Sada upravená místem z věty (P30B T6): bloky, plošiny a hladina pod závodem.
  const scene = useMemo(() => sceneLook(spec.theme), [spec.theme]);
  // Vlastní hudba a zvuky looku (P29D T5) – ve feedu jen aktivní hra; bez gesta nic nestahuje.
  useEffect(() => {
    if (!active) return;
    setSoundLook(lookOf(spec.theme));
    const stop = playMusic(musicFor(spec.theme));
    return () => {
      stop();
      setSoundLook(null);
    };
  }, [active, spec.theme]);
  // Hlas vypravěče (P29D T11): cíl hry po prvním gestu, jen publikovaná verze a jen když je nahrávka hotová.
  useEffect(() => {
    if (!active || offline) return;
    return playNarration(narrationUrl(versionId));
  }, [active, offline, versionId]);
  useEffect(() => {
    const offEvents = session.onEvents((events) => {
      for (const preset of presetsFor(events)) playSfx(preset);
    });
    let lastTick = -1;
    const offJump = session.subscribe(() => {
      const tick = session.state()[HEADER.tick] as number;
      if (tick === lastTick) return;
      lastTick = tick;
      if (session.humanRun() && jumped(session.prev(), session.state())) playSfx('jump');
    });
    return () => {
      offEvents();
      offJump();
    };
  }, [session]);

  // Chycení hráče (kit `08-game-hud.md`): zásah nebo prohra v běhu hráče otřese obrazovkou
  // (≤ 6 px, 200 ms, CSS `.play-caught`, s omezeným pohybem bez otřesu) a okraj pilulky
  // postupu na tu chvíli zrajčatí. Jádro neříká, co prohru způsobilo – bere se každá.
  const [caught, setCaught] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = session.onEvents((events) => {
      if (!session.humanRun() || !events.some((event) => event.kind === 'damage' || event.kind === 'lose')) return;
      const element = shell.current;
      if (element !== null) {
        // Znovu spustit animaci i při zásahu v jejím průběhu: bez přepočtu stylu by třída jen zůstala.
        element.classList.remove('play-caught');
        void element.offsetWidth;
        element.classList.add('play-caught');
      }
      setCaught(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        shell.current?.classList.remove('play-caught');
        setCaught(false);
      }, CAUGHT_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [session]);

  // Restart z HUD a z karty pauzy (P34 T5): nový běh od tiku 0, hra zase čeká na první dotek.
  const restart = useCallback(() => {
    if (session.humanRun()) loopEvent('restart', versionId);
    setLiveOpen(false);
    session.restart();
    session.resume();
  }, [session, versionId]);
  useHudKeys(menu && !aboutOpen, session.paused, (action) => {
    if (action === 'restart') restart();
    else if (action === 'pause') pauseGame();
    else session.resume();
  });
  // Prodloužení času živou změnou („more time“) posune i odpočet časovače.
  const bonus = session.patches().reduce((sum, entry) => sum + (entry.patch.kind === 'count' && entry.patch.counter === 'time' ? entry.patch.amount : 0), 0);

  useEffect(() => {
    const probe = {
      inputs: () => session.inputs(),
      tick: () => session.snapshot().tick,
      /** Živá těla role (P29D T9) – e2e jimi měří „more enemies“. */
      bodies: (role: ArcadeRole) => aliveOf(session.state(), role),
      patches: () => session.patches().length,
      /** Dotek bez vstupu (P33 T11): e2e, které čekají na běžící hodiny, hru pustí jako ťuk na prázdnou scénu. */
      start: () => session.begin(),
      playWitness: () => {
        const end = session.playInputs(session.botInputs(), ARCADE_LIMITS.maxTicks);
        return { runState: end.runState, tick: end.tick };
      },
      /**
       * Záznam robota zahraný „rukou“ (P28C T3): tytéž stisky tik po tiku cestou,
       * kterou jde klávesnice, takže běh je hráčův a odezva i zvuk reagují.
       * Stojí u prvního bodu (`score`) nebo na konci hry (`end`); `at` je
       * `performance.now()` té chvíle.
       */
      handPlay: (until: 'score' | 'end') => {
        const inputs = session.botInputs();
        session.restart();
        let next = 0;
        const done = (): boolean => {
          const now = session.snapshot();
          return now.runState !== 'running' || now.tick >= ARCADE_LIMITS.maxTicks || (until === 'score' && now.score > 0);
        };
        while (!done()) {
          const tick = session.snapshot().tick;
          while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
          const event = inputs[next]?.tick === tick ? inputs[next] : undefined;
          session.hold(event?.axis ?? 0);
          session.press(event?.buttons ?? 0);
          session.stepOnce();
        }
        const end = session.snapshot();
        return { runState: end.runState, tick: end.tick, score: end.score, at: performance.now() };
      },
    };
    // Tvar sondy je mřížkový (`inputs` vrací jiný záznam); e2e arkády čte jen `tick`, `playWitness` a `handPlay`.
    window.__playShell = probe as unknown as Window['__playShell'];
    return () => {
      if (window.__playShell === (probe as unknown)) delete window.__playShell;
    };
  }, [session]);

  return (
    // Pod plátnem obloha sady (P32D T6): do prvního snímku scény je vidět ona, ne tmavé pozadí stránky.
    // `data-playing`: hráč už hraje (první tah proběhl, ne přehrávaná ukázka) – lišta domova (P34 T3) mu ustoupí.
    // Obloha jde do proměnné `--_sky`: na desktopu jí je jen scéna 16:9, okolí je krémové (kit `05-layout.md`).
    <main ref={shell} className="play-shell" data-playing={active && demo === null && snapshot.tick > 0 ? 'true' : 'false'} style={{ '--_sky': scene.sky } as CSSProperties}>
      <ArcadeStage session={session} cast={cast} lookId={lookOf(spec.theme)} look={scene} enabled={active && running} overlay={<Weather session={session} theme={spec.theme} />} />
      {/* HUD kitu (P34 T5): dole restart, „Change one thing“ (živá změna, P29D T9) a sdílení (P27B T5); po dohrání je nese `PostRun`. */}
      <ArcadeHud
        spec={spec}
        world={arcade}
        snapshot={snapshot}
        heading={inFeed || offline ? 'h2' : 'h1'}
        bonus={bonus}
        paused={paused}
        caught={caught}
        onPause={menu ? pauseGame : undefined}
        bottom={
          menu && (
            <>
              <button type="button" className="sp-hud-btn play-hud-round" data-testid="play-hud-restart" aria-label="Restart" title="Restart (R)" onClick={restart}>
                <Icon name="restart" />
              </button>
              {canChange && (
                <Button variant="secondary" className="play-hud-change" data-testid="live-open" aria-expanded={liveOpen} onClick={() => setLiveOpen(true)}>
                  <Icon name="wand" />
                  {CHANGE_LABEL}
                </Button>
              )}
              {!offline && <ShareButton versionId={versionId} title={spec.title} variant="hud" className="play-hud-share" live={live} />}
            </>
          )
        }
      >
        {/* Ukázka robota (P27D T3) řekne, že neběží hra hráče, a vrátí ho do ní. */}
        {running && demo !== null && !demo.ended && (
          <aside className="sp-toast play-demo-note" role="status">
            <span data-testid="play-demo">Demo: the verified run of this version. Your score is not counted.</span>
            <Button variant="secondary" size="s" data-testid="play-demo-stop" onClick={() => session.restart()}>
              Stop and play
            </Button>
          </aside>
        )}
        {/* Živá změna (P29D T9): Enter otevírá pole jen tam, kde Enter nehraje (střelba, úder, ťuk). */}
        {canChange && <LiveBox session={session} spec={spec} remix={remix} enterOpens={enterOpensLiveBox(arcade)} open={liveOpen} setOpen={setLiveOpen} />}
        <UpgradeBanner request={upgrade} sentence={read?.sentence ?? null} />
        {running && <RemixReadyChip job={remix} />}
      </ArcadeHud>
      {/* Hodiny stojí na tiku 0, dokud se hráč nedotkne (P33 T11); ukázka robota výzvu nemá. */}
      {running && active && demo === null && snapshot.tick === 0 && <FirstPrompt controlsHint={spec.tutorial.controlsHint} />}
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} />
      {read !== undefined && <SentenceRead read={read} open={aboutOpen} onClose={() => setAboutOpen(false)} />}
      {lab !== undefined && <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />}
      {cardShown && (
        <PauseCard
          onResume={session.resume}
          onRestart={restart}
          onChange={
            canChange
              ? () => {
                  session.resume();
                  setLiveOpen(true);
                }
              : undefined
          }
          controlsHint={spec.tutorial.controlsHint}
        >
          <MuteButton />
          {read !== undefined && <AboutButton onOpen={() => setAboutOpen(true)} />}
          {/* „Show me how“ (P27D T3): přehraje záznam robota, kterým verze prošla publikací; pauzu zruší sám. */}
          {physicsReady && (
            <Button variant="secondary" size="s" data-testid="play-demo-start" onClick={() => session.startDemo()}>
              <Icon name="play" />
              Show me how
            </Button>
          )}
          {!offline && !inFeed && <MoreGames />}
        </PauseCard>
      )}
      {/* Konec ukázky není výhra hráče: bez „You won“, bez sdílení výsledku. */}
      {!running && demo !== null && !attract && (
        <section className="play-outcome" data-testid="play-demo-outcome" data-verified={String(demo.verified)} role="status">
          <h2 className="play-outcome-title">Demo finished</h2>
          <p className="play-outcome-detail">
            {demo.verified === true ? 'Same result and end state as the check this version passed.' : 'This replay did not match the check this version passed.'}
          </p>
          <button type="button" className="play-button" data-testid="play-demo-yours" onClick={() => session.restart()}>
            Play it yourself
          </button>
        </section>
      )}
      {!running && demo === null && settled && (
        <section className="play-outcome" data-testid="play-outcome" role="status">
          <h2 className="play-outcome-title">{snapshot.runState === 'won' ? 'You won' : 'You lost'}</h2>
          <p className="play-outcome-detail">
            {/* Aréna už čas nese v `progressLabel`. */}
            {spec.control === 'move_free' ? '' : `in ${secondsOf(snapshot.tick, ARCADE_HZ)} · `}
            {progressLabel(spec, snapshot)} · {snapshot.score} {scoreUnit(spec)}
          </p>
          {offline ? (
            <button type="button" className="play-button" data-testid="play-again" onClick={() => session.restart()}>
              Play again
            </button>
          ) : (
            <PostRun
              versionId={versionId}
              remix={remix}
              clip={clip}
              live={live}
              onReplay={() => {
                if (session.humanRun()) loopEvent('restart', versionId);
                session.restart();
              }}
            />
          )}
        </section>
      )}
    </main>
  );
}
