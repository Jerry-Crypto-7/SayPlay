/**
 * Duch řetězu mikroher (P56C T12): krokuje `stepChain` týmž výběrem vstupů jako `replayChain`, takže je v každém
 * globálním tiku v témž kole a stavu jako přehrání serveru. Leží u řetězu, ne v `ghost-source.ts`: přehrávač
 * řetězu táhne kompilátor kol a ten do balíčku `ArcadePlay` nepatří (`arcade-bundle.test.ts`).
 */

import { BODY, HEADER, type InputEvent, NO_INPUT, bodyBase } from '@/play/arcade/contract';
import type { ArcadeLibrary } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import type { ChainWorld } from '@/play/chain/contract';
import { type ChainState, chainHorizon, hashChain, startChain, stepChain } from '@/play/chain/run';

import type { GhostPose, GhostSource } from '../GhostSlot';
import { type GhostEnd, ghostRunOf, headingOf } from '../ghost-source';

/** Duch v globálním tiku: kolo, karta mezi koly a póza hrdiny (`null` během karty). */
export interface ChainGhostAt {
  readonly round: number;
  readonly card: boolean;
  readonly pose: GhostPose | null;
}

export interface ChainGhostReplay {
  /** Stav ducha v globálním tiku řetězu; `null` za koncem záznamu. */
  at(tick: number): ChainGhostAt | null;
  /** `hashChain` místa, kde duch po posledním `at` stojí – týž jako `replayChain` do toho tiku. */
  hash(): string;
  end(): GhostEnd | null;
  /** Zdroj pro scénu kola `round`, které hráč začal v globálním tiku `start`; duch v jiném kole se nekreslí. */
  forRound(round: number, start: number): GhostSource;
}

/** Zpět jen přetočením od tiku 0; o tik zpět (interpolace scény) vrátí uloženou předchozí pózu. */
export function createChainGhostSource(chain: ChainWorld, inputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY): ChainGhostReplay {
  const horizon = chainHorizon(chain);
  let run: ChainState = startChain(chain, library);
  let next = 0;
  let yaw = 0;
  let current: ChainGhostAt | null = null;
  let previous: ChainGhostAt | null = null;

  const view = (): ChainGhostAt => {
    if (run.card > 0) return { round: run.round, card: true, pose: null };
    const state = run.state;
    const base = bodyBase(state[HEADER.player] as number);
    yaw = headingOf(state, base, yaw);
    return { round: run.round, card: false, pose: { x: state[base + BODY.x] as number, y: state[base + BODY.y] as number, z: state[base + BODY.z] as number, yaw } };
  };

  const rewind = (): void => {
    run = startChain(chain, library);
    next = 0;
    yaw = 0;
    previous = null;
    current = view();
  };

  const stepOnce = (): void => {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < run.tick) next += 1;
    const event = inputs[next];
    stepChain(run, event !== undefined && event.tick === run.tick ? event : NO_INPUT);
    previous = current;
    current = view();
  };

  current = view();
  const at = (tick: number): ChainGhostAt | null => {
    if (!Number.isInteger(tick) || tick < 0) return null;
    if (tick === run.tick - 1 && previous !== null) return previous;
    if (tick < run.tick) rewind();
    while (run.tick < tick && run.outcome === 'running' && run.tick < horizon) stepOnce();
    return run.tick === tick ? current : null;
  };
  return {
    at,
    hash: () => hashChain(run),
    end: () => (run.outcome === 'running' ? null : { tick: run.tick, outcome: run.outcome, hash: hashChain(run) }),
    forRound: (round, start) => ({
      poseAt: (tick) => {
        const ghost = at(start + tick);
        return ghost !== null && ghost.round === round ? ghost.pose : null;
      },
    }),
  };
}

/** Duch řetězu z úložiště: záznam bez živých změn (řetěz je nemá, debata T9); jinak `null` a hra běží bez ducha. */
export async function fetchChainGhost(versionId: string, dareId: string, chain: ChainWorld, fetcher: typeof fetch = fetch): Promise<ChainGhostReplay | null> {
  try {
    const response = await fetcher(`/api/play/games/${encodeURIComponent(versionId)}/dare/${encodeURIComponent(dareId)}`);
    if (!response.ok) return null;
    const run = ghostRunOf(((await response.json()) as { replay?: unknown }).replay);
    return run === null || run.patches.length > 0 ? null : createChainGhostSource(chain, run.inputs);
  } catch {
    return null;
  }
}
