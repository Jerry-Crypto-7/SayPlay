'use client';

/**
 * Hráč řetězu mikroher (P56C T11): kolo je obyčejná `ArcadeStage` nad relací kola (`key` kola, takže scéna,
 * vstupy a modely začnou u každého kola znovu), mezi koly karta se slovesem, nahoře HUD kola a životů a na
 * konci výsledek se hvězdami proti paru robota řetězu (`starsFor`). Relaci a záznam drží `createChainSession`;
 * tenhle soubor jen kreslí. Duch a výzva jdou přes celý řetěz v globálních ticích (T12); AI verze ani remix
 * řetěz nemá (debata T9), hru ze čtení věty ano (P58E T3) – přejde na ni `UpgradeBanner`.
 */

import dynamic from 'next/dynamic';
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld } from '@/play/arcade/contract';
import { lookOf, sceneLook } from '@/play/arcade/look';
import { chaserModel, enemyModel, heroModel, preyModel, propModels, riggedModelOf, sceneModelOf } from '@/play/arcade/models';
import { bossKindOf } from '@/play/arcade/pieces/pacing';
import type { ChainWorld } from '@/play/chain/contract';
import { roundClock } from '@/play/chain/run';
import { type Par, starsFor } from '@/play/score/stars';
import type { GameSpecV1 } from '@/play/spec';

import type { Dare } from '../../best';
import { StageHost } from '../../feed/StageHost';
import type { StageTunnel } from '../../feed/stage-tunnel';
import { loopTouch } from '../../loop-client';
import { PostRun, type RunFacts } from '../../PostRun';
import { useRemixJob } from '../../RemixBox';
import { type DarePublish, publishDare } from '../../ShareButton';
import { BuildingScreen, GameHud, type HudCounter, objectiveShown } from '../../ui';
import { UpgradeBanner, useCommitted } from '../../UpgradeBanner';
import { EnterVrButton } from '../../xr/EnterVrButton';
import { useXrControls } from '../../xr/xr-context';
import { heroActionOf } from '../action-cue/cues';
import type { GhostLabel } from '../Ghost';
import { type ChainGhostReplay, fetchChainGhost } from './chain-ghost';
import { wakesGame } from '../ready-gate';
import { prebuildRunnerTerrain } from '../runner/terrain';
import type { Cast } from '../World';
import { ChainCard } from './ChainCard';
import { type ChainSession, createChainSession } from './chain-session';

// Scéna (three.js) jen v prohlížeči, jako v `ArcadePlay`.
const ArcadeStage = memo(dynamic(() => import('../ArcadeStage'), { ssr: false, loading: () => <BuildingScreen /> }));

/** Ovládání, u kterých kolo čeká v relaci na první stisk – táž sada jako `TAP_TO_START` v `ArcadePlay`. */
const TAP_TO_START = new Set(['flap', 'shooter', 'timing', 'rhythm', 'duel']);

/** Volby relace kola jako u jedné hry: hra na čas první stisk spolkne, poletování ho vezme jako mávnutí. */
function startOf(world: ArcadeWorld): { readonly waitForInput: boolean; readonly swallowFirst: boolean } {
  const control = baseControlOf(world.control).id;
  return { waitForInput: TAP_TO_START.has(control), swallowFirst: control !== 'flap' };
}

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

type ChainPlayProps = Parameters<typeof ChainRun>[0];

/**
 * Bez hostitele feedu (`/play/[id]`) dostane řetěz jedno trvalé plátno (`StageHost`, P54A T5) přes všechna kola:
 * scéna kola se remountuje, ale WebGL kontext a renderer zůstanou – vlastní `<Canvas>` na kolo stál na telefonu
 * při každém přechodu snímek 150–280 ms (T13). Scénu nového kola plátno staví odloženě (`deferScenes`) – do té doby
 * kreslí konec předchozího kola (T13a).
 */
export function ChainPlay(props: ChainPlayProps) {
  if (props.host !== undefined) return <ChainRun {...props} />;
  return (
    <StageHost keepPrograms deferScenes>
      {(host) => <ChainRun {...props} host={host} />}
    </StageHost>
  );
}

function ChainRun({
  versionId,
  spec,
  chain,
  par = null,
  active = true,
  inFeed = false,
  host,
  challenge = null,
  bestDare,
  upgrade = null,
  sentence = null,
}: {
  /** Adresa `GET …/upgrade` řetězu z věty (P58E T3): přechod na hru ze čtení, AI verzi řetěz nemá. */
  readonly upgrade?: string | null;
  readonly sentence?: string | null;
  /** Výzva kamaráda z `?dare=`, ověřená serverem; její běh hraje duch. */
  readonly challenge?: Dare | null;
  /** Id nejlepšího běhu ze stránky pro ducha; `null` = žádný, `undefined` = bez ducha nejlepšího běhu (feed). */
  readonly bestDare?: string | null;
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
  // Každé kolo čeká na první dotek (P70A T3): po kartě svět stojí, dokud se hráč nedotkne – nikdo neprohraje dřív.
  const [session] = useState(() => createChainSession(chain, { gate: true, startOf }));
  // Nový pokus (Try again = prohrané kolo, Play again = kolo 1) dá kolu novou relaci; scéna se musí postavit znovu i se stejným indexem kola.
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

  // Terén kol běžce staví worker hned po montáži řetězu: na hlavním vlákně by přechod do kola zasekl telefon o ~0,5 s (T18).
  // Pro světy relace (`session.worlds`), ne uložené – kolo se hraje s životy řetězu a terén se hledá podle objektu světa.
  useEffect(() => {
    if (!active) return;
    chain.rounds.forEach(({ spec: next }, index) => prebuildRunnerTerrain(session.worlds[index]!, sceneLook(next.theme)));
  }, [active, chain, session]);

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

  // První dotek pustí kolo (každé, i po kartě) v zachytávací fázi, takže tentýž stisk padne do tiku 0 (jako `ArcadePlay`).
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

  // Duch řetězu (T12): kamarád z odkazu výzvy má přednost před nejlepším během. Kreslí se jen v kole, kde je.
  const [ghost, setGhost] = useState<{ readonly replay: ChainGhostReplay; readonly label: GhostLabel } | null>(null);
  useEffect(() => {
    if (!active) return;
    const friend = challenge === null ? null : new URLSearchParams(window.location.search).get('dare');
    let live = true;
    void (async () => {
      const fromFriend = friend === null ? null : await fetchChainGhost(versionId, friend, chain);
      if (fromFriend !== null) return { replay: fromFriend, label: 'friend' as const };
      if (bestDare === undefined || bestDare === null || bestDare === friend) return null;
      const best = await fetchChainGhost(versionId, bestDare, chain);
      return best === null ? null : { replay: best, label: 'best' as const };
    })().then((found) => {
      if (live) setGhost(found);
    });
    return () => {
      live = false;
      setGhost(null);
    };
  }, [active, versionId, challenge, bestDare, chain]);
  const roundGhost = useMemo(() => (ghost === null ? undefined : { source: ghost.replay.forRound(at, session.start()), label: ghost.label }), [ghost, at, round, session]);
  // Duch v jiném kole se nekreslí; HUD řekne, ve kterém je.
  const ghostAt = ghost === null ? null : ghost.replay.at(session.tick());

  // Sonda času do ovladatelné hry (jako `ArcadePlay`, P32D T2): první skutečný vstup kola 1 na `arcade-stage`.
  const shell = useRef<HTMLElement>(null);
  useEffect(() => {
    if (at !== 0) return;
    let done = false;
    return round.subscribe(() => {
      if (done || !round.humanRun()) return;
      const first = round.inputs()[0];
      const stage = shell.current?.querySelector('[data-testid="arcade-stage"]');
      if (first === undefined || !stage) return;
      done = true;
      stage.setAttribute('data-input-tick', String(first.tick));
      stage.setAttribute('data-input-at', String(Date.now()));
    });
  }, [at, round]);

  // Sonda e2e (T13): kolo, které se hraje, od jeho tiku 0 – stisky robota kola (`bot`) nebo žádné (`idle`),
  // tik po tiku cestou klávesnice, takže záznam je hráčův a Dare z něj přehraje server.
  useEffect(() => {
    if (!active) return;
    const probe = {
      tick: () => session.tick(),
      round: () => session.round(),
      card: () => session.card(),
      lives: () => session.lives(),
      outcome: () => session.outcome(),
      hash: () => session.hash(),
      start: () => session.begin(),
      /** Robot kola v reálném čase (`startDemo`): měření snímků na telefonu, kolo i přechod se kreslí jako u hráče. */
      demo: () => {
        session.begin();
        session.current().startDemo();
      },
      /**
       * Klip slepého soudce (T14): robot kola (`startDemo`) dotočený synchronně do místního tiku `to`, takže snímek
       * ukáže stav v tom tiku; mezi snímky hraje dál týž robot v reálném čase. `Infinity` kolo dohraje. `null` = karta nebo konec.
       */
      demoTo: (to: number) => {
        if (session.card() > 0 || session.outcome() !== 'running') return null;
        const playing = session.round();
        const live = session.current();
        if (live.demo() === null) {
          session.begin();
          live.startDemo();
        }
        while (live.snapshot().runState === 'running' && live.snapshot().tick < Math.min(to, ARCADE_LIMITS.maxTicks)) live.stepOnce();
        return { round: playing, tick: live.snapshot().tick, runState: live.snapshot().runState };
      },
      playRound: (how: 'bot' | 'idle') => {
        const live = session.current();
        const inputs = how === 'bot' ? live.botInputs() : [];
        live.restart();
        session.begin();
        let next = 0;
        while (live.snapshot().runState === 'running' && live.snapshot().tick < ARCADE_LIMITS.maxTicks) {
          const tick = live.snapshot().tick;
          while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
          const event = inputs[next]?.tick === tick ? inputs[next] : undefined;
          live.hold(event?.axis ?? 0);
          live.press(event?.buttons ?? 0);
          live.stepOnce();
        }
        return { runState: live.snapshot().runState, round: session.results().length, lives: session.lives(), outcome: session.outcome(), tick: session.tick() };
      },
    };
    window.__playShell = probe as unknown as Window['__playShell'];
    return () => {
      if (window.__playShell === (probe as unknown)) delete window.__playShell;
    };
  }, [active, session]);

  const over = outcome !== 'running';
  // VR (P67 T1): „Enter VR“ s každým prohlížečem, který VR umí, i ve feedu; jinak dolní řada HUD nevznikne, jako dřív.
  const vrOffered = useXrControls()?.presenting === false && !over;
  // Výhra pošle záznam s globálními tiky jako výzvu hned, ne až po stisku – nabídka sdílení chce čerstvé gesto.
  const [dare, setDare] = useState<DarePublish | undefined>(undefined);
  useEffect(() => {
    if (outcome !== 'won') {
      setDare(undefined);
      return;
    }
    let live = true;
    setDare({ state: 'pending' });
    publishDare(versionId, session.inputs(), []).then(
      (dareId) => live && setDare({ state: 'ready', dareId }),
      () => live && setDare({ state: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [outcome, versionId, session, attempt]);
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
  const committed = useCommitted(session.tick() / ARCADE_HZ, over);

  return (
    <main ref={shell} className="play-shell" data-chain-round={at + 1} data-chain-view={view} style={{ '--_sky': scene.sky } as CSSProperties}>
      {/* Kolo mění jen scénu žánru (`sceneKey`); rig, skládač a efekty plátna zůstávají – nová stavba všeho stála na telefonu snímky 150–430 ms (T13a). */}
      <ArcadeStage
        sceneKey={`${String(attempt)}-${String(at)}`}
        session={round}
        cast={cast}
        lookId={lookOf(roundSpec.theme)}
        look={scene}
        enabled={playing}
        heroAction={heroActionOf(roundSpec)}
        abilityWords={roundSpec.abilityWords}
        ghost={roundGhost}
        host={host}
      />
      <GameHud
        title={spec.title}
        heading={inFeed ? 'h2' : 'h1'}
        goalLine={at === 0 ? `${chain.rounds[0]!.card} ${roundSpec.tutorial.goalLine}` : roundSpec.tutorial.goalLine}
        counters={[
          { label: 'round', count: at + 1, text: `${String(at + 1)}/${String(rounds)}`, icon: 'flag' },
          { label: 'lives', count: session.lives(), text: String(session.lives()), icon: 'heart' },
          ...(ghostAt !== null && ghostAt.round !== at ? [{ label: 'ghost', count: ghostAt.round + 1, text: `Ghost ${String(ghostAt.round + 1)}/${String(rounds)}` } satisfies HudCounter] : []),
        ]}
        clock={clock === null ? { seconds: snapshot.tick / ARCADE_HZ, countdown: false } : { seconds: (clock - snapshot.tick) / ARCADE_HZ, countdown: true }}
        objective={!over && objectiveShown(snapshot.tick, ARCADE_HZ, false)}
        keepGoal={!over}
        bottom={vrOffered && <EnterVrButton />}
      >
        {!inFeed && <UpgradeBanner request={upgrade} sentence={sentence} versionId={versionId} committed={committed} chain />}
      </GameHud>
      {carding && !over && <ChainCard card={chain.rounds[session.round()]!.card} twist={chain.rounds[session.round()]!.twist} round={session.round() + 1} rounds={rounds} />}
      {over && settled && (
        <PostRun
          versionId={versionId}
          remix={remix}
          facts={facts}
          dare={dare}
          challenge={challenge}
          // Remix řetězu server odmítá (422, debata T9).
          remixable={false}
          onReplay={(via) => {
            // Po prohře znovu prohrané kolo, vyhraná kola zůstanou (P70A T3); po výhře řetěz od kola 1.
            session.restart();
            setAttempt((value) => value + 1);
            // Klávesa nového pokusu je zároveň první dotek: kolo jede hned.
            if (via === 'key') session.begin();
          }}
        />
      )}
    </main>
  );
}
