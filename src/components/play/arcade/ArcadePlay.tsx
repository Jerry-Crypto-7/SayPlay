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
import { useEffect, useState, useSyncExternalStore } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_LIMITS, type ArcadeWorld } from '@/play/arcade/contract';
import { lookOf } from '@/play/arcade/look';
import { chaserModel, enemyModel, heroModel, propModels } from '@/play/arcade/models';
import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { HowItWorks } from '../HowItWorks';
import { timerLeft } from '../Hud';
import type { LabFacts, ReadFacts } from '../lab';
import { SentenceRead } from '../SentenceRead';
import { Lineage } from '../Lineage';
import { PostRun } from '../PostRun';
import { UpgradeBanner, useUpgrade } from '../UpgradeBanner';

import { createArcadeSession, type ArcadeSnapshot } from './session';

// WebGL kontext na serveru není – stejně jako mřížkové plátno.
const ArcadeStage = dynamic(() => import('./ArcadeStage'), { ssr: false });


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

function ArcadeHud({ spec, world, snapshot }: { readonly spec: GameSpecV1; readonly world: ArcadeWorld; readonly snapshot: ArcadeSnapshot }) {
  const lives = spec.mechanics.some((m) => m.id === 'health') || spec.addons?.includes('lives') === true ? ` · ${snapshot.health} lives` : '';
  // Arkáda tiká 60× za sekundu (viz `progressLabel`).
  const clock = timerLeft(spec, Math.floor(snapshot.tick / 60));
  return (
    <header className="play-hud" aria-label="Game status">
      <h1 className="play-hud-title">{spec.title}</h1>
      <p className="play-hud-goal" data-testid="play-goal">{spec.tutorial.goalLine}</p>
      <p className="play-hud-hint">
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
  readonly lab: LabFacts;
  readonly read: ReadFacts;
  readonly upgrade: string | null;
}

export function ArcadePlay({ versionId, spec, arcade, lineage, remixes, aiVersion = false, lab, read, upgrade }: ArcadePlayProps) {
  const upgraded = useUpgrade(upgrade);
  // Poletování, střelnice a hry na čas čekají na první stisk: ptáček by spadl a vlna
  // došla dřív, než hráč hru uvidí. `swallowFirst` navíc ten spouštěcí ťuk nezapíše –
  // u načasování by to byl rovnou minutý pokus (u poletování je to první mávnutí).
  const [session] = useState(() => {
    const control = baseControlOf(arcade.control).id;
    return createArcadeSession(arcade, { waitForInput: TAP_TO_START.has(control), swallowFirst: control !== 'flap' });
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const running = snapshot.runState === 'running';

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
      <ArcadeStage session={session} cast={{ player: heroModel(spec), enemy: enemyModel(spec), chaser: chaserModel(spec), props: propModels(spec) }} lookId={lookOf(spec.theme)} />
      <ArcadeHud spec={spec} world={arcade} snapshot={snapshot} />
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} />
      {upgraded !== null && <UpgradeBanner versionId={upgraded} />}
      <SentenceRead read={read} />
      <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />
      {!running && (
        <section className="play-outcome" data-testid="play-outcome" role="status">
          <h2 className="play-outcome-title">{snapshot.runState === 'won' ? 'You won' : 'You lost'}</h2>
          <p className="play-outcome-detail">
            {progressLabel(spec, snapshot)} · {snapshot.score} {scoreUnit(spec)}
          </p>
          <PostRun versionId={versionId} onReplay={() => session.restart()} />
        </section>
      )}
    </main>
  );
}
