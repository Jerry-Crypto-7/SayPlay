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
import { ARCADE_LIMITS, type ArcadeWorld } from '@/play/arcade/contract';
import { lookOf } from '@/play/arcade/look';
import { chaserModel, enemyModel, heroModel, propModels } from '@/play/arcade/models';
import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { HowItWorks } from '../HowItWorks';
import { loopEvent, loopImpression } from '../loop-client';
import { timerLeft } from '../Hud';
import type { LabFacts, ReadFacts } from '../lab';
import { SentenceRead } from '../SentenceRead';
import { ShareButton } from '../ShareButton';
import { Lineage } from '../Lineage';
import { PostRun } from '../PostRun';
import { UpgradeBanner } from '../UpgradeBanner';

import { createArcadeSession, type ArcadeSession, type ArcadeSnapshot, type DemoState } from './session';

// WebGL kontext na serveru není – stejně jako mřížkové plátno. `memo`: HUD se překresluje
// každý tik, plátno ne – scéna čte relaci sama v `useFrame` (P28E-R1: na emulovaném
// telefonu srovnání stovek těl runneru 20× za sekundu bralo většinu snímku).
const ArcadeStage = memo(dynamic(() => import('./ArcadeStage'), { ssr: false }));


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
    ? `${Math.floor(snapshot.tick / 60)} s`
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

function ArcadeHud({ versionId, spec, world, snapshot, paused, children }: { readonly versionId: string; readonly spec: GameSpecV1; readonly world: ArcadeWorld; readonly snapshot: ArcadeSnapshot; readonly paused: boolean; readonly children?: ReactNode }) {
  const lives = spec.mechanics.some((m) => m.id === 'health') || spec.addons?.includes('lives') === true ? ` · ${snapshot.health} lives` : '';
  // Arkáda tiká 60× za sekundu (viz `progressLabel`).
  const clock = timerLeft(spec, Math.floor(snapshot.tick / 60));
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
      {/* Sdílení během hry (P27B T5); po dohrání ho nese `PostRun`. */}
      {snapshot.runState === 'running' && <ShareButton versionId={versionId} title={spec.title} className="play-hud-share" />}
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
}

/** Klávesa do pole formuláře hru neobnoví – píše se tam věta, ne hraje. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);

export function ArcadePlay({ versionId, spec, arcade, lineage, remixes, aiVersion = false, lab, read, upgrade, active = true }: ArcadePlayProps) {
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

  // Pauza při skryté záložce a mimo obrazovku feedu. Sama se hra nerozběhne:
  // obnoví ji až vstup hráče, a to v zachytávací fázi, takže ten stisk už do hry padne
  // (u poletování je to rovnou mávnutí). Rytmus nepípá, když tiky stojí.
  useEffect(() => {
    if (!active) {
      session.pause();
      return;
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') session.pause();
    };
    const wake = () => {
      if (session.paused() && document.visibilityState === 'visible') session.resume();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="arcade-stage"]') !== null) wake();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!event.repeat && !typing(event.target)) wake();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active, session]);

  // Události smyčky (P27D T4): zobrazení, první vstup a konec běhu – jen za člověka.
  useEffect(() => {
    if (active) loopImpression(versionId);
  }, [active, versionId]);
  useEffect(() => {
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
  }, [session, versionId]);

  useEffect(() => {
    const probe = {
      inputs: () => session.inputs(),
      tick: () => session.snapshot().tick,
      playWitness: () => {
        const end = session.playInputs(session.botInputs(), ARCADE_LIMITS.maxTicks);
        return { runState: end.runState, tick: end.tick };
      },
    };
    // Tvar sondy je mřížkový (`inputs` vrací jiný záznam); e2e arkády čte jen `tick` a `playWitness`.
    window.__playShell = probe as unknown as Window['__playShell'];
    return () => {
      if (window.__playShell === (probe as unknown)) delete window.__playShell;
    };
  }, [session]);

  return (
    <main className="play-shell">
      <ArcadeStage session={session} cast={cast} lookId={lookOf(spec.theme)} />
      <ArcadeHud versionId={versionId} spec={spec} world={arcade} snapshot={snapshot} paused={paused}>
        {running && <DemoControl session={session} demo={demo} />}
      </ArcadeHud>
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} />
      <UpgradeBanner request={upgrade} sentence={read?.sentence ?? null} />
      {read !== undefined && <SentenceRead read={read} />}
      {lab !== undefined && <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />}
      {/* Konec ukázky není výhra hráče: bez „You won“, bez sdílení výsledku. */}
      {!running && demo !== null && (
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
      {!running && demo === null && (
        <section className="play-outcome" data-testid="play-outcome" role="status">
          <h2 className="play-outcome-title">{snapshot.runState === 'won' ? 'You won' : 'You lost'}</h2>
          <p className="play-outcome-detail">
            {progressLabel(spec, snapshot)} · {snapshot.score} {scoreUnit(spec)}
          </p>
          <PostRun
            versionId={versionId}
            onReplay={() => {
              if (session.humanRun()) loopEvent('restart', versionId);
              session.restart();
            }}
          />
        </section>
      )}
    </main>
  );
}
