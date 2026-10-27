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
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeRole, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase, nativeRule } from '@/play/arcade/contract';
import { hashArcade, instantiate, worldHasPhysics } from '@/play/arcade/kernel';
import { lookOf, sceneLook } from '@/play/arcade/look';
import obstacleKits from '@/play/arcade/look/obstacle-kits.json';
import { chaserModel, chaserName, enemyModel, heroModel, preyModel, propModels, riggedModelOf, sceneModelOf } from '@/play/arcade/models';
import { DUEL } from '@/play/arcade/pieces/duel';
import { bossKindOf } from '@/play/arcade/pieces/pacing';
import { targetModelOf } from '@/play/arcade/target-model';
import { holdUntilRapier, loadRapier, prefetchRapier, rapierIfLoaded } from '@/play/arcade/physics/world';
import { actionPresets, installSoundControls, jumped, playMusic, playNarration, playSfx, presetsFor, setMusicTension, setSoundLook, vibrateFor } from '@/play/audio';
import { musicFor, narrationUrl, tenseMusicFor } from '@/play/audio/library';
import { createTension } from '@/play/audio/tension';
import { CHAIN_RUNTIME_VERSION } from '@/play/chain/contract';
import type { GameVersion } from '@/play/contracts';
import { type Par, type RunResult, starsFor } from '@/play/score/stars';
import type { GameSpecV1 } from '@/play/spec';
import type { FeedPreview } from '@/play/version/version';

import { type Best, type BestOutcome, bestGoal, type Dare, dareGoal, dareStart, readBest, settleBest } from '../best';
import type { StageTunnel } from '../feed/stage-tunnel';
import { AHEAD, NEW_BEST } from '../starters';
import { HowItWorks } from '../HowItWorks';
import { loopEvent, loopImpression, loopTouch } from '../loop-client';
import { FirstPrompt } from '../FirstPrompt';
import { MoreGames } from '../MoreGames';
import { BuildingScreen, Button, CHANGE_LABEL, GameHud, type HudCounter, type HudGoal, Icon, PauseCard, objectiveShown, useHudKeys } from '../ui';
import { timerLeft } from '../timer';
import type { LabFacts, ReadFacts } from '../lab';
import { AboutButton, SentenceRead } from '../SentenceRead';
import { type DarePublish, type LivePublish, publishDare, ShareButton } from '../ShareButton';
import { Lineage } from '../Lineage';
import { MuteButton } from '../MuteButton';
import { EnterVrButton } from '../xr/EnterVrButton';
import { PostRun, type ResultStat, type RunFacts } from '../PostRun';
import { RemixReadyChip, useRemixJob } from '../RemixBox';
import { UpgradeBanner, useCommitted } from '../UpgradeBanner';

import { type BotHand, botHand } from './bot-hand';
import { type Clip, startClip } from './clip';
import { publishLive } from './live-share';
import { pauseWhenAway } from './focus';
import { bestOnce, type LoadedGhost, loadGhost } from './GhostSlot';
import { isTyping } from './input';
import { heroActionOf } from './action-cue/cues';
import { nameLines, nameSlotAt } from './action-cue/name-line';
import { NameLine } from './action-cue/NameLine';
import { verbLine, verbLineShown } from './action-cue/verb-line';
import { VerbLine } from './action-cue/VerbLine';
import { LaneEventBanner, laneEventViewOf } from './LaneEventBanner';
import { PacingBanner } from './PacingBanner';
import { LiveBox, enterOpensLiveBox } from './LiveBox';
import { holdUntilTouch, wakesGame } from './ready-gate';
import { ZONE_HINTS } from './touch-zones';
import { Weather } from './Weather';
import { createArcadeSession, loopDemo, type ArcadeSession, type ArcadeSnapshot } from './session';

// WebGL kontext na serveru není – stejně jako mřížkové plátno. `memo`: HUD se překresluje
// každý tik, plátno ne – scéna čte relaci sama v `useFrame` (P28E-R1: na emulovaném
// telefonu srovnání stovek těl runneru 20× za sekundu bralo většinu snímku).
// Než kód scény dorazí, stojí nad oblohou sady (P32D T6) kroky stavby na papírové kartě (P34 T4); název nese HUD.
const ArcadeStage = memo(dynamic(() => import('./ArcadeStage'), { ssr: false, loading: () => <BuildingScreen /> }));
// Chunky three.js stahovat už při načtení modulu, ne až po hydrataci: `dynamic` začne
// až při prvním renderu a do té doby síť stojí (P28E T5, mezera ~0,25 s na telefonu).
if (typeof window !== 'undefined') void import('./ArcadeStage');


/** Střelba a hod nemají trať: místo metrů ukazují zbývající rány. */
const aiming = (spec: GameSpecV1): boolean => spec.control === 'shooter' || spec.control === 'throw' || spec.control === 'ball';

/** Mince tepu sbírá jen nová hra chytání (značka `tuning.segments`, `catchSpec`); uložená počítá snědené jako dřív. */
const catchCoins = (spec: GameSpecV1): boolean => {
  const params = spec.controlParams as { readonly generator?: string; readonly tuning?: { readonly segments?: boolean } } | undefined;
  return params?.generator === 'arena_catch' && params.tuning?.segments === true;
};

/**
 * Co hra počítá: se `scoring` (P36A T5) body s kombem a bonusem za výhru, ne kusy;
 * jinak mince u běžce, plošinovky a nového chytání (P51 T4a, mince tepu), turba v závodě, snědené v aréně, jinak body.
 */
export const scoreUnit = (spec: GameSpecV1): string =>
  spec.scoring !== undefined
    ? 'points'
    : spec.control === 'runner' || spec.control === 'platform' || catchCoins(spec)
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
export function limitOf(world: ArcadeWorld): number | null {
  const seconds = nativeRule(world.rules, 'time_limit', 'survive_time')?.params.seconds;
  return typeof seconds === 'number' ? seconds : null;
}

/** Hra na přežití (`survive_time`): cíl a výsledek se měří časem. */
export const survives = (world: ArcadeWorld): boolean => nativeRule(world.rules, 'survive_time') !== undefined;

/** Střelba s municí (`blaster`): HUD ukáže počítadlo nábojů. */
export const countsAmmo = (world: ArcadeWorld): boolean => nativeRule(world.rules, 'blaster') !== undefined;

/** Kolik předmětů doplňku `+collect` hra chce (`finish_collected`); `null` = cíl bez sbírání. */
export function collectNeed(world: ArcadeWorld): number | null {
  const need = Number(nativeRule(world.rules, 'finish_collected')?.params.need);
  return Number.isFinite(need) && need > 0 ? need : null;
}

/** Počítadlo cíle (P61 T5): slovo věty s počtem (`finish_collected.noun`, „keys“) vidět v pilulce, jinak „collected“ jen čtečce. */
export function collectGoal(world: ArcadeWorld, count: number): HudGoal | null {
  const need = collectNeed(world);
  if (need === null) return null;
  const noun = nativeRule(world.rules, 'finish_collected')?.params.noun;
  return typeof noun === 'string' ? { label: noun, count, need, said: true } : { label: 'collected', count, need };
}

const hasLives = (spec: GameSpecV1): boolean => spec.mechanics.some((m) => m.id === 'health') || spec.addons?.includes('lives') === true || spec.control === 'steer' && typeof spec.controlParams?.crashBudget === 'number';

/**
 * Fakta skončeného běhu pro výsledek (P34 T6) – jen čísla, která relace
 * arkády opravdu počítá: sebrané předměty, životy, body jednotkou hry
 * a uběhlá část trati (aréna, střelba a hod trať nemají). Body jdou zvlášť
 * jako velké skóre (P36B T2) – jen u hry, která boduje: něco nabodoval hráč
 * nebo robot paru. Hvězdy proti paru (`starsFor`); hra bez paru = 1 za výhru.
 */
function arcadeFacts(spec: GameSpecV1, world: ArcadeWorld, snapshot: ArcadeSnapshot, par: Par | null, livesStart: number): RunFacts {
  const goal = collectGoal(world, snapshot.items);
  const extra: ResultStat[] = [];
  if (hasLives(spec)) extra.push({ value: String(snapshot.health), label: 'lives left' });
  if (spec.control !== 'move_free' && !aiming(spec)) extra.push({ value: `${snapshot.progress}%`, label: 'of the way' });
  const scoring = snapshot.score !== 0 || (par !== null && par.score > 0);
  return {
    won: snapshot.runState === 'won',
    tick: snapshot.tick,
    hz: ARCADE_HZ,
    survive: survives(world),
    goal: goal === null ? null : { count: goal.count, need: goal.need, label: goal.label },
    extra,
    score: scoring ? { value: snapshot.score, unit: scoreUnit(spec) } : null,
    stars: starsFor(runOf(snapshot, livesStart), par),
  };
}

/** Konec běhu pro hvězdy a rekord; `livesStart` = čítač životů světa v tiku 0. */
const runOf = (snapshot: ArcadeSnapshot, livesStart: number): RunResult => ({
  won: snapshot.runState === 'won',
  score: snapshot.score,
  ticks: snapshot.tick,
  lives: snapshot.health,
  livesStart,
});

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
  target = null,
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
  /** Cíl k překonání (P36B T4) – poslední položka pilulky postupu. */
  readonly target?: HudCounter | null;
  readonly onPause?: () => void;
  readonly bottom?: ReactNode;
  readonly children?: ReactNode;
}) {
  const lives = hasLives(spec) ? ` · ${snapshot.health} lives` : '';
  const clock = timerLeft(spec, Math.floor(snapshot.tick / ARCADE_HZ));
  const counters: HudCounter[] = [];
  if (aiming(spec)) counters.push({ label: 'shots', count: snapshot.shots, text: `${snapshot.shots} ${spec.control === 'throw' ? 'throws' : 'shots'} left` });
  if (countsAmmo(world)) counters.push({ label: 'ammo', count: snapshot.shots, text: `${snapshot.shots} ammo` });
  if (hasLives(spec)) counters.push({ label: 'lives', count: snapshot.health, text: String(snapshot.health), icon: 'heart' });
  if (target !== null) counters.push(target);
  const limit = limitOf(world);
  const elapsed = snapshot.tick / ARCADE_HZ;
  return (
    <GameHud
      title={spec.title}
      heading={heading}
      goalLine={spec.tutorial.goalLine}
      goal={collectGoal(world, snapshot.items)}
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
  readonly readingVersion?: boolean;
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
  /** Vítězný běh robota z publikace (`report.par`, P36B T1); chybí = hvězdy jen 1 za výhru. */
  readonly par?: Par | null;
  /** Výzva kamaráda z odkazu `?dare=` (P36B T7): cíl na kartě startu a v HUD, výsledek proti ní. */
  readonly challenge?: Dare | null;
  /** Id výzvy nejlepšího běhu ze stránky (P50 T6), `null` = žádný; chybí = duch se zeptá `GET /api/play/games/:id`. */
  readonly bestDare?: string | null;
  /** Náhled robota z publikace (P54A T2): ve feedu ho výloha hraje dokola místo celé ukázky, ťuk převezme hru. */
  readonly preview?: FeedPreview;
  /** Trvalé plátno feedu (P54A T5): scéna se kreslí do něj místo vlastního. */
  readonly host?: StageTunnel;
}

const END_PAUSE_MS = 600;
/** Po prohře výsledek dřív (P36B T3): oslava tu není a „Try again“ má být po ruce do 300 ms. */
const LOSS_PAUSE_MS = 300;
/** Jak dlouho HUD ukazuje „New best!“, když hráč rekord přebije za běhu (P36B T4); pak cíl zmizí. */
const NEW_BEST_MS = 2000;

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
  readingVersion = false,
  lab,
  read,
  upgrade,
  active = true,
  offline = false,
  inFeed = false,
  par = null,
  challenge = null,
  bestDare,
  preview,
  host,
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
  // Nápověda dotyku, kterou text hry neřekne (zóny plošinovky, P36C T2).
  const zoneHint = ZONE_HINTS[baseControlOf(arcade.control).id];
  const cast = useMemo(() => {
    const props = propModels(spec);
    if (spec.controlParams?.generator === 'quest_spatial' || spec.controlParams?.generator === 'quest_station') {
      delete props.target;
      const target = targetModelOf(spec);
      if (target !== undefined) props.target = target;
    }
    // Boss od režiséra (P46E T4) dostane model své věci z obsazení, když ji katalog má.
    const bossKind = spec.boss === undefined ? null : bossKindOf(arcade);
    const bossModel = spec.boss === undefined ? undefined : (riggedModelOf(spec.boss.role) ?? sceneModelOf(spec.boss.role, true));
    const prey = preyModel(spec);
    return { player: heroModel(spec), enemy: enemyModel(spec), chaser: chaserModel(spec), props, ...(prey === undefined ? {} : { prey }),
    kit: obstacleKits.kits[lookOf(spec.theme)],
    ...(bossKind === null || bossModel === undefined ? {} : { boss: { kind: bossKind, model: bossModel } }),
    things: Object.fromEntries(spec.roles.flatMap(role => {
      if (role.id === 'pad' && role.label === 'landing pad') return [];
      const model = sceneModelOf(role.label, false);
      return model === undefined ? [] : [[role.id, model]];
    })),
    };
  }, [spec, arcade]);
  // Jméno nepřítele a bosse v banneru průběhu (P46B T7): popisek role, jejíž model je kreslí.
  const foe = useMemo(() => chaserName(spec), [spec]);
  const running = snapshot.runState === 'running';
  const paused = useSyncExternalStore(session.subscribe, session.paused, session.paused);
  const demo = useSyncExternalStore(session.subscribe, session.demo, session.demo);
  // Hra ze čtení (P58D T3) přepne sama jen hráče, který ještě nehraje – ukázka se nepočítá.
  const committed = useCommitted(demo === null ? snapshot.tick / ARCADE_HZ : 0, demo === null && !running);
  const remix = useRemixJob(versionId, !running && demo === null);
  const live = useLivePublish(versionId, spec, arcade, session, !offline);
  // Živá změna (P29D T9) jen v běžící hře hráče; s koncem běhu se pole zavře, ať se v další nevynoří samo.
  const canChange = running && active && demo === null && physicsReady;
  useEffect(() => {
    if (!canChange) setLiveOpen(false);
  }, [canChange]);
  // Konec má váhu (P28C T3): výsledek až END_PAUSE_MS po výhře – mezitím doběhne klip oslavy a zazní zvuk; po prohře jen LOSS_PAUSE_MS.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (running) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), session.snapshot().runState === 'won' ? END_PAUSE_MS : LOSS_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [running, session]);

  // Klip běhu (P29D T1): nahrává se od startu běhu hráče, po konci ještě dojezd plátna.
  // Ukázka robota klip nemá; plátno se načítá dynamicky, proto se hledá při každém tiku, než je.
  const shell = useRef<HTMLElement | null>(null);
  const [clip, setClip] = useState<Blob | null>(null);
  // Běh se právě nahrává: list sdílení v HUD (P34 T7) ukáže Save video zašedlé s větou, že video přijde po konci.
  const [filming, setFilming] = useState(false);
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
        setFilming(false);
      }
      if (nowRunning && !tried) {
        const canvas = shell.current?.querySelector<HTMLCanvasElement>('[data-testid="arcade-stage"] canvas');
        if (canvas) {
          tried = true;
          recording = startClip(canvas);
          setFilming(recording !== null);
        }
      }
      if (!nowRunning && wasRunning && recording !== null) {
        const ended = recording;
        recording = null;
        setFilming(false);
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
  // bez něj runner do tří sekund prohraje a první obrazovka ukáže „So close.“. První stisk
  // nebo ťuk na scénu výlohu ukončí v zachytávací fázi, takže ten stisk už padne do hry hráče.
  const [attract, setAttract] = useState(offline || (inFeed && preview !== undefined));
  useEffect(() => {
    if (!attract || !active || !physicsReady) return;
    // Ve feedu (P54A T5) okno náhledu robota z publikace – smyčku drží relace sama.
    if (preview !== undefined && session.demo()?.preview !== true) session.startPreview(preview);
    const stopLoop = preview === undefined ? loopDemo(session) : () => undefined;
    // Restart hodiny znovu zastaví; tenhle dotek je první vstup hráče, proto je hned pustí.
    const take = () => {
      setAttract(false);
      session.restart();
      session.begin();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="arcade-stage"]') !== null) take();
    };
    // Ve feedu Tab a Esc hru nepřevezmou – klávesnice musí dojít k akcím karty (revize /ship P54A).
    const onKey = (event: KeyboardEvent) => {
      if (inFeed ? wakesGame(event) : !event.repeat && !isTyping(event.target)) take();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      stopLoop();
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [attract, active, physicsReady, session, preview]);

  // První dotek (P33 T11): ťuk na scénu nebo klávesa pustí hodiny v zachytávací fázi,
  // takže tentýž stisk padne do tiku 0. Tlačítka mimo scénu (zvuk, info, Play again) ne.
  useEffect(() => {
    if (!active) return;
    // Spouštěcí dotek je dotek hry, i když ho `swallowFirst` do vstupů nepustí (P40 T4) – odchod pak není okamžitý.
    const start = () => {
      session.begin();
      loopTouch(versionId);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="arcade-stage"]') !== null) start();
    };
    const onKey = (event: KeyboardEvent) => {
      if (wakesGame(event)) start();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active, session, versionId]);

  // Události smyčky (P27D T4): zobrazení, první vstup a konec běhu – jen za člověka.
  // Na konci běhu se jednou vyřídí i osobní rekord (P36B T2); výsledek ho jen ukáže.
  // Výhra pošle vstupy na server jako výzvu Dare (P36B T6) hned, ne až po stisku –
  // nabídka sdílení chce čerstvé gesto. Odpověď staršího běhu se zahodí (`attempt`).
  const livesStart = useMemo(() => instantiate(arcade)[HEADER.counters + COUNTER.health] as number, [arcade]);
  const [record, setRecord] = useState<BestOutcome | null>(null);
  const [dare, setDare] = useState<DarePublish | undefined>(undefined);
  useEffect(() => {
    if (active && !offline) loopImpression(versionId);
  }, [active, offline, versionId]);
  useEffect(() => {
    if (offline) return;
    let reported = false;
    let attempt = 0;
    const off = session.subscribe(() => {
      if (!session.humanRun()) return;
      const now = session.snapshot();
      if (now.runState === 'running') {
        if (reported) {
          setRecord(null);
          setDare(undefined);
          attempt += 1;
        }
        reported = false;
      }
      if (session.inputs().length > 0) loopEvent('first_input', versionId);
      if (now.runState !== 'running' && !reported) {
        reported = true;
        loopEvent(now.runState === 'won' ? 'win' : 'lose', versionId);
        const run = runOf(now, livesStart);
        setRecord(settleBest(versionId, { won: run.won, score: run.score, ticks: run.ticks, stars: starsFor(run, par) }));
        if (run.won) {
          const mine = attempt;
          setDare({ state: 'pending' });
          publishDare(versionId, session.inputs(), session.patches()).then(
            (dareId) => mine === attempt && setDare({ state: 'ready', dareId }),
            () => mine === attempt && setDare({ state: 'failed' }),
          );
        }
      }
    });
    return () => {
      attempt += 1;
      off();
    };
  }, [offline, session, versionId, livesStart, par]);

  // Cíl k překonání v HUD (P36B T4): rekord z prohlížeče, přečtený po připojení a s každým
  // novým během (`record` se vynuluje). Přebité body ukážou na chvíli „New best!“, pak cíl zmizí.
  // Výzva kamaráda (P36B T7) má přednost: cíl je jeho výsledek a přebité body řeknou „You're ahead!“.
  const [best, setBest] = useState<Best | null>(null);
  useEffect(() => {
    if (!offline && record === null) setBest(readBest(versionId));
  }, [offline, record, versionId]);
  const survive = survives(arcade);
  const verb = useMemo(() => verbLine(spec), [spec]);
  // Souboj: od prvního útoku řádek přenechá místo povelům nad soupeřem (P58C T6b), jinak by se s nimi překryl.
  const duel = baseControlOf(arcade.control).id === 'duel';
  const names = useMemo(() => nameLines(spec), [spec]);
  const nameSlot = running && active ? nameSlotAt(snapshot.tick, ARCADE_HZ, demo === null, verb !== null) : null;
  const goal = useMemo(() => (challenge === null ? bestGoal(best, ARCADE_HZ, survive) : dareGoal(challenge, ARCADE_HZ, survive)), [best, challenge, survive]);
  const goalLabel = challenge === null ? 'best' : 'dare';
  const beaten = goal !== null && goal.score !== null && snapshot.score > goal.score;
  const [cheered, setCheered] = useState(false);
  useEffect(() => {
    if (!beaten) {
      setCheered(false);
      return;
    }
    const timer = window.setTimeout(() => setCheered(true), NEW_BEST_MS);
    return () => window.clearTimeout(timer);
  }, [beaten]);
  const target: HudCounter | null =
    goal === null || demo !== null || cheered
      ? null
      : beaten
        ? { label: goalLabel, count: snapshot.score, text: challenge === null ? NEW_BEST : AHEAD, fresh: true }
        : { label: goalLabel, count: goal.score ?? 0, text: goal.text };

  // Duch (P37B T8, `GHOST.md`): kamarád z odkazu výzvy, jinak nejlepší běh hry – jednou na aktivní
  // hru z úložiště. Id kamarádovy výzvy nese adresa `/play/[id]?dare=`, stránka ji ověřila (`challenge`).
  // Nejlepší běh poslala stránka (P50 T6) – jen pro první načtení, další se ptá úložiště znovu.
  const [ghost, setGhost] = useState<LoadedGhost | null>(null);
  const [pageBest] = useState(() => bestOnce(bestDare));
  useEffect(() => {
    if (offline || !active) return;
    const friend = challenge === null ? null : new URLSearchParams(window.location.search).get('dare');
    let live = true;
    let loaded: LoadedGhost | null = null;
    void loadGhost(versionId, friend, arcade, fetch, pageBest()).then((found) => {
      loaded = found;
      if (live) setGhost(found);
      else found?.source.dispose();
    });
    return () => {
      live = false;
      setGhost(null);
      loaded?.source.dispose();
    };
  }, [offline, active, versionId, challenge, arcade, pageBest]);

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
    const stop = playMusic(musicFor(spec.theme), tenseMusicFor(spec.theme));
    return () => {
      stop();
      setSoundLook(null);
    };
  }, [active, spec.theme]);
  // Hudba podle napětí (P37B T5): poslední život, poslední sekundy, soupeř blízko – jen čte stav, jen za člověka.
  useEffect(() => {
    if (!active) return;
    const tense = createTension(livesStart, limitOf(arcade));
    const off = session.subscribe(() => setMusicTension(session.humanRun() && tense(session.state())));
    return () => {
      off();
      setMusicTension(false);
    };
  }, [active, session, arcade, livesStart]);
  // Hlas vypravěče (P29D T11): cíl hry po prvním gestu, jen publikovaná verze a jen když je nahrávka hotová.
  useEffect(() => {
    if (!active || offline) return;
    return playNarration(narrationUrl(versionId));
  }, [active, offline, versionId]);
  useEffect(() => {
    const offEvents = session.onEvents((events) => {
      const presets = presetsFor(events);
      for (const preset of presets) playSfx(preset);
      // Haptika (P36C T3): posluchač efektů slyší jen tiky, které hraje člověk.
      vibrateFor(presets);
    });
    const control = baseControlOf(session.world.control).id;
    let lastTick = -1;
    let heard = 0;
    const offJump = session.subscribe(() => {
      const tick = session.state()[HEADER.tick] as number;
      if (tick === lastTick) return;
      lastTick = tick;
      // Zvuky akcí (P36C T3) z nových záznamů vstupu; restart záznam zkrátí, přehrání a ukázka mlčí.
      const inputs = session.inputs();
      if (inputs.length < heard) heard = 0;
      if (session.humanRun()) for (const preset of actionPresets(control, inputs, heard)) playSfx(preset);
      heard = inputs.length;
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
    let hand: BotHand | null = null;
    const probe = {
      /**
       * Hra gesty (P36C T4, `bot-hand.ts`): `byHand(true)` na tiku 0 zastaví čas snímků,
       * `botWants()` řekne, co by robot teď stiskl, e2e to zahraje dotykem a `tickByHand()`
       * odtiká tik s tím, co gesta zapsala.
       */
      byHand: (on: boolean) => {
        session.manualClock(on);
        hand = on ? botHand(session) : null;
      },
      botWants: () => hand?.decide() ?? null,
      /** Vstup hráče do příštího tiku bez gesta (P37B T8): měření FPS s duchem tak hraje robot za hráče. */
      hold: (axis: number) => session.hold(axis),
      press: (buttons: number) => session.press(buttons),
      tickByHand: () => {
        hand?.step();
        const now = session.snapshot();
        // `health`: e2e akcí (P47B T10) jím měří, že dash prošel nárazem bez ztráty života.
        return { runState: now.runState, tick: now.tick, progress: now.progress, score: now.score, items: now.items, health: now.health };
      },
      inputs: () => session.inputs(),
      /** One synchronous sample: real input events and the exact state they reached. */
      capture: () => ({ inputs: session.inputs(), tick: session.snapshot().tick, hash: hashArcade(session.state()) }),
      physicsReady: () => !worldHasPhysics(arcade) || rapierIfLoaded() !== null,
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
       * `performance.now()` té chvíle. `lag` posune stisky o tolik tiků později
       * – e2e výzvy (P36B T7) tak dostane pomalejší výhru téhož robota.
       */
      handPlay: (until: 'score' | 'end', lag = 0) => {
        const inputs = session.botInputs().map((event) => ({ ...event, tick: event.tick + lag }));
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
      /** Běh hráče bez jediného stisku až do konce (P36B T3): e2e prohraje bez čekání na hodiny. */
      idleRun: () => {
        session.restart();
        while (session.snapshot().runState === 'running' && session.snapshot().tick < ARCADE_LIMITS.maxTicks) session.stepOnce();
        const end = session.snapshot();
        return { runState: end.runState, tick: end.tick };
      },
    };
    // Tvar sondy je mřížkový (`inputs` vrací jiný záznam); e2e arkády čte jen `tick`, `playWitness`, `handPlay` a `idleRun`.
    window.__playShell = probe as unknown as Window['__playShell'];
    return () => {
      if (window.__playShell === (probe as unknown)) delete window.__playShell;
    };
  }, [session]);

  // Ohlášení událostí pruhů (P55): jen žánry, které je mají.
  const laneEventView = laneEventViewOf(session.world.rules);

  return (
    // Pod plátnem obzor sady (P32D T6, P56B T4): do prvního snímku scény je vidět on, ne tmavé pozadí stránky.
    // Obzor, ne `sky`: vesmírná `sky` je skoro černá a pomalý první snímek (překlad shaderů) dal černou obrazovku;
    // obzor je i barva pozadí scény (`StyleRig`), takže první snímek na něj navazuje.
    // `data-playing`: hráč už hraje (první tah proběhl, ne přehrávaná ukázka) – lišta domova (P34 T3) mu ustoupí.
    // Barva jde do proměnné `--_sky`: na desktopu jí je jen scéna 16:9, okolí je krémové (kit `05-layout.md`).
    <main ref={shell} className="play-shell" data-playing={active && demo === null && snapshot.tick > 0 ? 'true' : 'false'} style={{ '--_sky': scene.horizon } as CSSProperties}>
      <ArcadeStage
        session={session}
        cast={cast}
        lookId={lookOf(spec.theme)}
        look={scene}
        enabled={active && running}
        heroAction={heroActionOf(spec)}
        // Ukázka robota není závod: duch jen v běhu hráče.
        ghost={demo === null && ghost !== null ? ghost : undefined}
        // Sloveso věty na tlačítkách akcí (P47B T10) – jen popisek, svět ho nečte.
        abilityWords={spec.abilityWords}
        host={host}
        keepFrame={versionId}
        names={names.bodies}
        overlay={
          <>
            <Weather session={session} theme={spec.theme} />
            {/* Hodiny stojí na tiku 0, dokud se hráč nedotkne (P33 T11); ukázka robota výzvu nemá. Na plátně, ať ji stage postaví mimo hrdinu (P35 T6). */}
            {running && active && demo === null && snapshot.tick === 0 && (
              <FirstPrompt
                controlsHint={spec.tutorial.controlsHint}
                touch={zoneHint}
                dare={challenge === null ? null : { goal: dareStart(challenge, ARCADE_HZ, survive), changed: challenge.liveChanges > 0 }}
              />
            )}
            {/* Sloveso, které hra hraje (P43 T7), první tři vteřiny po prvním tahu. Cílovou větu doplňuje, nenahrazuje. */}
            {running && active && verb !== null && verbLineShown(snapshot.tick, ARCADE_HZ, demo === null, duel ? DUEL.lead : undefined) && <VerbLine line={verb} />}
            {/* Jméno hrdiny a nejbližšího těla z věty (P58A T5), po řádku se slovesem, každé 1,5 s; `key` přehraje nástup štítku. */}
            {nameSlot !== null && (nameSlot === 'foe' || names.hero !== null) && <NameLine key={nameSlot} slot={nameSlot} hero={names.hero} />}
            <PacingBanner session={session} enabled={running && active} foe={foe} boss={spec.boss?.name} />
            {laneEventView !== null && <LaneEventBanner session={session} enabled={running && active} visible={laneEventView} />}
          </>
        }
      />
      {/* HUD kitu (P34 T5): dole restart, „Change one thing“ (živá změna, P29D T9) a sdílení (P27B T5); po dohrání je nese `PostRun`. */}
      <ArcadeHud
        spec={spec}
        world={arcade}
        snapshot={snapshot}
        heading={inFeed || offline ? 'h2' : 'h1'}
        bonus={bonus}
        paused={paused}
        caught={caught}
        target={target}
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
              {!offline && <ShareButton versionId={versionId} title={spec.title} variant="hud" className="play-hud-share" live={live} recording={filming} />}
              {/* VR (P65 T1): jen s `?vr=1` a prohlížečem, který VR umí; feed zůstává 2D. */}
              {!inFeed && <EnterVrButton />}
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
        {/* AI verze vede přepínačem zpátky na rychlou (P38); feed mezi verzemi nepřepíná. */}
        <UpgradeBanner
          request={upgrade}
          sentence={read?.sentence ?? null}
          quick={aiVersion && !inFeed ? (lineage.at(-2)?.versionId ?? null) : null}
          matchedOf={readingVersion && !inFeed ? (lineage.at(-2)?.versionId ?? null) : null}
          versionId={versionId}
          committed={committed}
          // Hra ze čtení řetězu (P58E T3) se ptá řetězu: konec `CHAIN` bez věty, Quick vede zpátky na řetěz.
          chain={readingVersion && lineage.at(-2)?.runtimeVersion === CHAIN_RUNTIME_VERSION}
        />
        {running && <RemixReadyChip job={remix} />}
      </ArcadeHud>
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} reading={readingVersion} />
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
          touch={zoneHint}
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
      {/* Konec ukázky není výhra hráče: bez „You did it!“, bez sdílení výsledku. */}
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
      {/* Výsledek kitu (P34 T6): zamrzlá scéna nahoře, list s nadpisem, statistikami a akcemi. */}
      {!running && demo === null && settled && (
        <PostRun
          versionId={versionId}
          remix={remix}
          facts={arcadeFacts(spec, arcade, snapshot, par, livesStart)}
          clip={clip}
          live={live}
          dare={dare}
          challenge={challenge}
          offline={offline}
          record={record}
          controlsHint={spec.tutorial.controlsHint}
          onReplay={(via) => {
            if (!offline && session.humanRun()) loopEvent('restart', versionId);
            session.restart();
            // Klávesa nového pokusu (P36B T3) je zároveň první dotek: nový běh jede hned, bez výzvy.
            if (via === 'key') session.begin();
          }}
        />
      )}
    </main>
  );
}
