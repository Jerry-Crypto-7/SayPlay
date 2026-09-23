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

import { ARCADE_LIMITS, type ArcadeWorld } from '@/play/arcade/contract';
import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { HowItWorks } from '../HowItWorks';
import type { LabFacts } from '../lab';
import { Lineage } from '../Lineage';
import { PostRun } from '../PostRun';
import { UpgradeBanner, useUpgrade } from '../UpgradeBanner';

import { createArcadeSession, type ArcadeSnapshot } from './session';

// WebGL kontext na serveru není – stejně jako mřížkové plátno.
const ArcadeStage = dynamic(() => import('./ArcadeStage'), { ssr: false });

/** Hrdinové, kteří v katalogu mají model; jiný popisek hráče kreslí `explorer`. */
const HERO_MODELS = new Set(['explorer', 'robot', 'fox', 'kid', 'raccoon', 'astronaut', 'knight', 'penguin', 'cat', 'hamster', 'goblin', 'slime', 'seal', 'ghost']);

/** Poletování bez známého hrdiny kreslí ptáčka (primitiv), ostatní `explorer`. */
function heroModel(spec: GameSpecV1): string {
  const label = spec.roles.find((role) => role.kind === 'player')?.label.toLowerCase() ?? '';
  const noun = label.split(/\s+/).at(-1) ?? '';
  return HERO_MODELS.has(noun) ? noun : spec.control === 'flap' ? 'bird' : 'explorer';
}

/** Nepřátelé střelnice: model z popisku role, když ho katalog má, jinak robot. */
function enemyModel(spec: GameSpecV1): string {
  const noun = spec.roles.find((role) => role.id === 'enemy')?.label.toLowerCase().split(/\s+/).at(-1) ?? '';
  return HERO_MODELS.has(noun) ? noun : 'robot';
}

/** Střelba a hod nemají trať: místo metrů ukazují zbývající rány. */
const aiming = (spec: GameSpecV1): boolean => spec.control === 'shooter' || spec.control === 'throw';

/** Poletování počítá i průlety mezerou, ne jen mince; střelba a hod zásahy. */
const scoreUnit = (spec: GameSpecV1): string => (spec.control === 'flap' ? 'points' : aiming(spec) ? 'hits' : 'coins');

const distanceOf = (spec: GameSpecV1, snapshot: ArcadeSnapshot): string =>
  aiming(spec) ? `${snapshot.shots} ${spec.control === 'throw' ? 'throws' : 'shots'} left` : `${snapshot.distanceM} m`;

function ArcadeHud({ spec, snapshot }: { readonly spec: GameSpecV1; readonly snapshot: ArcadeSnapshot }) {
  const lives = spec.mechanics.some((m) => m.id === 'health') ? ` · ${snapshot.health} lives` : '';
  return (
    <header className="play-hud" aria-label="Game status">
      <h1 className="play-hud-title">{spec.title}</h1>
      <p className="play-hud-goal" data-testid="play-goal">{spec.tutorial.goalLine}</p>
      <p className="play-hud-hint">{spec.tutorial.controlsHint}</p>
      <p className="play-hud-progress">
        <span data-testid="play-progress" data-progress={snapshot.progress}>
          {snapshot.progress}% · {snapshot.score} {scoreUnit(spec)}{lives}
        </span>
        <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick}>
          {distanceOf(spec, snapshot)}
        </span>
      </p>
    </header>
  );
}

export interface ArcadePlayProps {
  readonly versionId: string;
  readonly spec: GameSpecV1;
  readonly arcade: ArcadeWorld;
  readonly lineage: readonly GameVersion[];
  readonly remixes: number;
  readonly lab: LabFacts;
  readonly upgrade: string | null;
}

export function ArcadePlay({ versionId, spec, arcade, lineage, remixes, lab, upgrade }: ArcadePlayProps) {
  const upgraded = useUpgrade(upgrade);
  // Poletování a střelnice čekají na první stisk: ptáček by spadl a vlna došla dřív, než hráč hru uvidí.
  const [session] = useState(() => createArcadeSession(arcade, { waitForInput: arcade.control.id === 'flap' || arcade.control.id === 'shooter' }));
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
      <ArcadeStage session={session} playerModel={heroModel(spec)} enemyModel={enemyModel(spec)} />
      <ArcadeHud spec={spec} snapshot={snapshot} />
      <Lineage lineage={lineage} remixes={remixes} />
      {upgraded !== null && <UpgradeBanner versionId={upgraded} />}
      <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />
      {!running && (
        <section className="play-outcome" data-testid="play-outcome" role="status">
          <h2 className="play-outcome-title">{snapshot.runState === 'won' ? 'You won' : 'You lost'}</h2>
          <p className="play-outcome-detail">
            {distanceOf(spec, snapshot)} · {snapshot.score} {scoreUnit(spec)}
          </p>
          <PostRun versionId={versionId} onReplay={() => session.restart()} />
        </section>
      )}
    </main>
  );
}
