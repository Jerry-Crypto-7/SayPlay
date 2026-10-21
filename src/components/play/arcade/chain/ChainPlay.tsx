'use client';

/**
 * Hráč řetězu mikroher (P56C T11): kolo je obyčejná `ArcadeStage` nad relací kola (`key` kola, takže scéna,
 * vstupy a modely začnou u každého kola znovu), mezi koly karta se slovesem, nahoře HUD kola a životů a na
 * konci výsledek se hvězdami proti paru robota řetězu (`starsFor`). Relaci a záznam drží `createChainSession`;
 * tenhle soubor jen kreslí. Výzva a duch řetězu přijdou v T12, AI verze ani remix řetěz nemá (debata T9).
 */

import dynamic from 'next/dynamic';
import { type CSSProperties, memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, type ArcadeWorld } from '@/play/arcade/contract';
import { lookOf, sceneLook } from '@/play/arcade/look';
import { chaserModel, enemyModel, heroModel, preyModel, propModels, riggedModelOf, sceneModelOf } from '@/play/arcade/models';
import { bossKindOf } from '@/play/arcade/pieces/pacing';
import type { ChainWorld } from '@/play/chain/contract';
import { roundClock } from '@/play/chain/run';
import { type Par, starsFor } from '@/play/score/stars';
import type { GameSpecV1 } from '@/play/spec';

import type { StageTunnel } from '../../feed/stage-tunnel';
import { loopTouch } from '../../loop-client';
import { PostRun, type RunFacts } from '../../PostRun';
import { useRemixJob } from '../../RemixBox';
import { BuildingScreen, GameHud, objectiveShown } from '../../ui';
import { heroActionOf } from '../action-cue/cues';
import { wakesGame } from '../ready-gate';
import type { Cast } from '../World';
import { ChainCard } from './ChainCard';
import { type ChainSession, createChainSession } from './chain-session';

// Scéna (three.js) jen v prohlížeči, jako v `ArcadePlay`.
const ArcadeStage = memo(dynamic(() => import('../ArcadeStage'), { ssr: false, loading: () => <BuildingScreen /> }));

/** Ovládání, u kterých kolo 1 čeká v relaci na první stisk – táž sada jako `TAP_TO_START` v `ArcadePlay`. */
const TAP_TO_START = new Set(['flap', 'shooter', 'timing', 'rhythm', 'duel']);

/** Výsledek až po doběhnutí klipu konce kola. */
const RESULT_PAUSE_MS = 900;

/** Obsazení kola ze specu – tytéž modely, které by kolu dal `ArcadePlay`. */
function castOf(spec: GameSpecV1, world: ArcadeWorld): Cast {
  const bossKind = spec.boss === undefined ? null : bossKindOf(world);
  const bossModel = spec.boss === undefined ? undefined : (riggedModelOf(spec.boss.role) ?? sceneModelOf(spec.boss.role, true));
  const prey = preyModel(spec);
  return {
    player: heroModel(spec),
    enemy: enemyModel(spec),
    chaser: chaserModel(spec),
    props: propModels(spec),
    ...(prey === undefined ? {} : { prey }),
    ...(bossKind === null || bossModel === undefined ? {} : { boss: { kind: bossKind, model: bossModel } }),
    things: Object.fromEntries(
      spec.roles.flatMap((role) => {
        const model = sceneModelOf(role.label, false);
        return model === undefined ? [] : [[role.id, model]];
      }),
    ),
  };
}

/** Index kola, jehož relaci `current()` vrací: během karty to, které skončilo. */
const shownRound = (session: ChainSession): number => (session.card() > 0 ? session.round() - 1 : session.round());

export function ChainPlay({
  versionId,
  spec,
  chain,
  par = null,
  active = true,
  inFeed = false,
  host,
}: {
  readonly versionId: string;
  /** Spec hry – kolo 1; název a téma řetězu. */
  readonly spec: GameSpecV1;
  readonly chain: ChainWorld;
  /** Par robota řetězu (`report.par` z `verifyChain`). */
  readonly par?: Par | null;
  readonly active?: boolean;
  readonly inFeed?: boolean;
  readonly host?: StageTunnel;
}) {
  const [session] = useState(() => {
    const control = baseControlOf(chain.rounds[0]!.world.control).id;
    return createChainSession(chain, { gate: true, first: { waitForInput: TAP_TO_START.has(control), swallowFirst: control !== 'flap' } });
  });
  // Restart řetězu dá kolu 1 novou relaci; scéna se musí postavit znovu i se stejným indexem kola.
  const [attempt, setAttempt] = useState(0);
  const view = useSyncExternalStore(session.subscribe, () => `${shownRound(session)}|${session.card()}|${session.outcome()}|${session.lives()}`, () => '0|0|running|0');
  const at = shownRound(session);
  const card = session.card();
  const outcome = session.outcome();
  const round = session.current();
  const roundSpec = chain.rounds[at]!.spec;
  const snapshot = useSyncExternalStore(round.subscribe, round.snapshot, round.snapshot);
  const cast = useMemo(() => castOf(roundSpec, round.world), [roundSpec, round]);
  const scene = useMemo(() => sceneLook(roundSpec.theme), [roundSpec.theme]);
  const clock = useMemo(() => roundClock(round.world), [round]);
  const remix = useRemixJob(versionId, false);

  // Karta mezi koly: hodiny karty jdou snímky prohlížeče, kolo pak pohání jeho scéna.
  const carding = card > 0;
  useEffect(() => {
    if (!carding) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      session.advance(now - last);
      last = now;
      if (session.card() > 0) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [carding, session]);

  // První dotek pustí kolo 1 v zachytávací fázi, takže tentýž stisk padne do tiku 0 (jako `ArcadePlay`).
  useEffect(() => {
    if (!active) return;
    const start = () => {
      if (!session.waiting()) return;
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

  const over = outcome !== 'running';
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!over) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), RESULT_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [over]);

  const rounds = chain.rounds.length;
  const won = outcome === 'won';
  const facts: RunFacts = {
    won,
    tick: session.tick(),
    hz: ARCADE_HZ,
    survive: false,
    goal: { count: session.results().filter((result) => result === 'won').length, need: rounds, label: 'rounds' },
    extra: [{ value: String(session.lives()), label: 'lives left' }],
    score: { value: session.score(), unit: 'points' },
    stars: starsFor({ won, score: session.score(), ticks: session.tick(), lives: session.lives(), livesStart: chain.lives }, par),
  };
  const playing = active && card === 0 && !over && snapshot.runState === 'running';

  return (
    <main className="play-shell" data-chain-round={at + 1} data-chain-view={view} style={{ '--_sky': scene.sky } as CSSProperties}>
      <ArcadeStage
        key={`${String(attempt)}-${String(at)}`}
        session={round}
        cast={cast}
        lookId={lookOf(roundSpec.theme)}
        look={scene}
        enabled={playing}
        heroAction={heroActionOf(roundSpec)}
        abilityWords={roundSpec.abilityWords}
        host={host}
      />
      <GameHud
        title={spec.title}
        heading={inFeed ? 'h2' : 'h1'}
        goalLine={at === 0 ? `${chain.rounds[0]!.card} ${roundSpec.tutorial.goalLine}` : roundSpec.tutorial.goalLine}
        counters={[
          { label: 'round', count: at + 1, text: `${String(at + 1)}/${String(rounds)}`, icon: 'flag' },
          { label: 'lives', count: session.lives(), text: String(session.lives()), icon: 'heart' },
        ]}
        clock={clock === null ? { seconds: snapshot.tick / ARCADE_HZ, countdown: false } : { seconds: (clock - snapshot.tick) / ARCADE_HZ, countdown: true }}
        objective={!over && objectiveShown(snapshot.tick, ARCADE_HZ, false)}
      />
      {carding && !over && <ChainCard card={chain.rounds[session.round()]!.card} round={session.round() + 1} rounds={rounds} />}
      {over && settled && (
        <PostRun
          versionId={versionId}
          remix={remix}
          facts={facts}
          // Sdílení a výzva řetězu přijdou v T12; remix řetězu server odmítá (422), proto jen znovu hrát.
          offline
          onReplay={(via) => {
            session.restart();
            setAttempt((value) => value + 1);
            // Klávesa nového pokusu je zároveň první dotek: nový řetěz jede hned.
            if (via === 'key') session.begin();
          }}
        />
      )}
    </main>
  );
}
