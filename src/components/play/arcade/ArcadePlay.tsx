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
import { memo, type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld, HEADER } from '@/play/arcade/contract';
import { lookOf } from '@/play/arcade/look';
import { chaserModel, enemyModel, heroModel, propModels } from '@/play/arcade/models';
import { installSoundControls, jumped, playSfx, presetsFor } from '@/play/audio';
import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { HowItWorks } from '../HowItWorks';
import { loopEvent, loopImpression } from '../loop-client';
import { FirstPrompt } from '../FirstPrompt';
import { secondsOf, timerLeft } from '../timer';
import type { LabFacts, ReadFacts } from '../lab';
import { SentenceRead } from '../SentenceRead';
import { ShareButton } from '../ShareButton';
import { Lineage } from '../Lineage';
import { MuteButton } from '../MuteButton';
import { PostRun } from '../PostRun';
import { RemixReadyChip, useRemixJob } from '../RemixBox';
import { UpgradeBanner } from '../UpgradeBanner';

import { pauseWhenAway } from './focus';
import { isTyping } from './input';
import { createArcadeSession, type ArcadeSession, type ArcadeSnapshot, type DemoState } from './session';

// WebGL kontext na serveru není – stejně jako mřížkové plátno. `memo`: HUD se překresluje
// každý tik, plátno ne – scéna čte relaci sama v `useFrame` (P28E-R1: na emulovaném
// telefonu srovnání stovek těl runneru 20× za sekundu bralo většinu snímku).
const ArcadeStage = memo(dynamic(() => import('./ArcadeStage'), { ssr: false }));
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

/**
 * Počítadla doplňků (P26D): sebrané mince proti potřebě a náboje. Popisek jde
 * do `data-testid` (`hud-counter-…`) a musí být v uzavřeném anglickém seznamu
 * `e2e/hud-labels.ts`.
 */
function AddonCounters({ world, snapshot }: { readonly world: ArcadeWorld; readonly snapshot: ArcadeSnapshot }) {
  const need = world.rules.find((rule) => rule.id === 'finish_collected')?.params.need;
  const fires = world.rules.some((rule) => rule.id === 'blaster');
  if (need === undefined && !fires) return null;
  return (
    <p className="play-hud-progress">
      {need !== undefined && (
        <span data-testid="hud-counter-collected" data-count={snapshot.items}>
          {snapshot.items}/{String(need)} collected
        </span>
      )}
      {fires && (
        <span data-testid="hud-counter-ammo" data-count={snapshot.shots}>
          {snapshot.shots} ammo
        </span>
      )}
    </p>
  );
}

/**
 * „Show me how“ (P27D T3): přehraje záznam robota, kterým verze prošla
 * publikací. Během ukázky je to napsané v HUD a jde ji zastavit.
 */
function DemoControl({ session, demo }: { readonly session: ArcadeSession; readonly demo: DemoState | null }) {
  if (demo === null) {
    return (
      <button type="button" className="play-button play-hud-demo" data-testid="play-demo-start" onClick={() => session.startDemo()}>
        Show me how
      </button>
    );
  }
  if (demo.ended) return null;
  return (
    <p className="play-hud-progress" data-testid="play-demo">
      <span>Demo: the verified run of this version. Your score is not counted.</span>{' '}
      <button type="button" className="play-button play-hud-demo" data-testid="play-demo-stop" onClick={() => session.restart()}>
        Stop and play
      </button>
    </p>
  );
}

function ArcadeHud({ versionId, spec, world, snapshot, paused, shareable, children }: { readonly versionId: string; readonly shareable: boolean; readonly spec: GameSpecV1; readonly world: ArcadeWorld; readonly snapshot: ArcadeSnapshot; readonly paused: boolean; readonly children?: ReactNode }) {
  const lives = spec.mechanics.some((m) => m.id === 'health') || spec.addons?.includes('lives') === true ? ` · ${snapshot.health} lives` : '';
  const clock = timerLeft(spec, Math.floor(snapshot.tick / ARCADE_HZ));
  return (
    <header className="play-hud" aria-label="Game status">
      <h1 className="play-hud-title">{spec.title}</h1>
      <p className="play-hud-goal" data-testid="play-goal">{spec.tutorial.goalLine}</p>
      <p className="play-hud-hint">
        {paused && snapshot.runState === 'running' ? <span data-testid="play-paused">Paused. Tap or press a key to resume. </span> : null}
        {snapshot.tick === 0 && spec.control !== undefined && TAP_TO_START.has(spec.control) ? 'Tap to start. ' : ''}
        {spec.tutorial.controlsHint}
      </p>
      <p className="play-hud-progress">
        <span data-testid="play-progress" data-progress={snapshot.progress}>
          {/* Aréna nemá trať, procento by stálo na nule. */}
          {spec.control === 'move_free' ? '' : `${snapshot.progress}% · `}
          {snapshot.score} {scoreUnit(spec)}{lives}
          {clock === null ? '' : ` · ${clock}`}
        </span>
        <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick}>
          {progressLabel(spec, snapshot)}
        </span>
      </p>
      <AddonCounters world={world} snapshot={snapshot} />
      {children}
      <MuteButton />
      {/* Sdílení během hry (P27B T5); po dohrání ho nese `PostRun`. */}
      {shareable && snapshot.runState === 'running' && <ShareButton versionId={versionId} title={spec.title} className="play-hud-share" />}
    </header>
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
}

const END_PAUSE_MS = 600;

export function ArcadePlay({ versionId, spec, arcade, lineage, remixes, aiVersion = false, lab, read, upgrade, active = true, offline = false }: ArcadePlayProps) {
  // Poletování, střelnice a hry na čas čekají na první stisk: ptáček by spadl a vlna
  // došla dřív, než hráč hru uvidí. `swallowFirst` navíc ten spouštěcí ťuk nezapíše –
  // u načasování by to byl rovnou minutý pokus (u poletování je to první mávnutí).
  const [session] = useState(() => {
    const control = baseControlOf(arcade.control).id;
    return createArcadeSession(arcade, { waitForInput: TAP_TO_START.has(control), swallowFirst: control !== 'flap' });
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const cast = useMemo(() => ({ player: heroModel(spec), enemy: enemyModel(spec), chaser: chaserModel(spec), props: propModels(spec) }), [spec]);
  const running = snapshot.runState === 'running';
  const paused = useSyncExternalStore(session.subscribe, session.paused, session.paused);
  const demo = useSyncExternalStore(session.subscribe, session.demo, session.demo);
  const remix = useRemixJob(versionId, !running && demo === null);
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

  // Pauza mimo obrazovku feedu, při skryté záložce a oknu bez fokusu (`focus.ts`).
  // Rytmus nepípá, když tiky stojí.
  useEffect(() => {
    if (!active) {
      session.pause();
      return;
    }
    return pauseWhenAway(session, window, document);
  }, [active, session]);

  // Výloha vstupní stránky (P28D T7): dokud se hráč nedotkne, hraje dokola robot ověřovače –
  // bez něj runner do tří sekund prohraje a první obrazovka ukáže „You lost“. První stisk
  // nebo ťuk na scénu výlohu ukončí v zachytávací fázi, takže ten stisk už padne do hry hráče.
  const [attract, setAttract] = useState(offline);
  useEffect(() => {
    if (!attract || !active) return;
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
    const take = () => {
      setAttract(false);
      session.restart();
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
  }, [attract, active, session]);

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

  // Zvuk (P28C T2): efekty pravidel z tiků hráče a skok z rychlosti vzhůru – mimo stav.
  useEffect(() => installSoundControls(), []);
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

  useEffect(() => {
    const probe = {
      inputs: () => session.inputs(),
      tick: () => session.snapshot().tick,
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
    <main className="play-shell">
      <ArcadeStage session={session} cast={cast} lookId={lookOf(spec.theme)} enabled={active && running} />
      <ArcadeHud versionId={versionId} spec={spec} world={arcade} snapshot={snapshot} paused={paused} shareable={!offline}>
        {running && <DemoControl session={session} demo={demo} />}
      </ArcadeHud>
      {running && active && <FirstPrompt controlsHint={spec.tutorial.controlsHint} />}
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} />
      <UpgradeBanner request={upgrade} sentence={read?.sentence ?? null} />
      {running && <RemixReadyChip job={remix} />}
      {read !== undefined && <SentenceRead read={read} />}
      {lab !== undefined && <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />}
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
