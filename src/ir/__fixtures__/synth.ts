/**
 * Syntetický generátor světů — **bez modelu**.
 *
 * Review v2 (Q3) na tom trvalo z konkrétního důvodu: původní AC volalo
 * `create(promptA)` dřív, než modelový klient vůbec existuje, a `promptA + patch`
 * nemá definovaný formát. Se skutečnou generací by navíc rovnost hashů nebyla
 * deterministická — dva běhy téhož promptu nedají tentýž dokument, takže by test
 * měřil model, ne potrubí.
 *
 * Tady se dvojice `(worldA, patch)` **konstruuje**, takže `worldB` je známý
 * předem a test se může ptát na jedinou věc, na kterou se ptát má: dá aplikace
 * patche na `worldA` bitově tentýž `simHash` jako přímo sestavený `worldB`?
 *
 * `pure-rand` je jediná povolená PRNG (`CLAUDE.md`) — bez seedu by fixture nebyly
 * reprodukovatelné a padající test by se nedal zopakovat.
 */

import type { Operation } from 'rfc6902';

import { createStreams, nextInt } from '../../sim/rng';
import { WORLD_DOC_VERSION, sealSimHash, type LookPart, type SimPart, type WorldDoc } from '../worlddoc';

/** Systémový default vzhledu. V P1 ho emituje SYSTÉM, ne model (`p1Status`). */
export function defaultLook(): LookPart {
  return {
    modules: { hero: { family: 'capsule', scale: 1 } },
    palette: ['#1d2b2f', '#2f9e8f', '#e8d9a0'],
    lightRig: { key: 1.4, ambient: 0.6 },
    atmosphere: { fog: 0.02 },
    materialRoles: { hero: 'matte', floor: 'matte' },
    camera: { fov: 45, distance: 6 },
    audio: { bed: 'none' },
  };
}

function simOf(seed: number): SimPart {
  const stream = createStreams(seed).layout;
  const width = nextInt(stream, 4, 12);
  const height = nextInt(stream, 4, 12);
  const keys = nextInt(stream, 1, 3);

  return {
    layout: { type: 'grid', floors: 1 },
    grid: { width, height, step: 1 },
    sockets: { s_start: [1, 1], s_goal: [width - 1, height - 1] },
    collisionAabb: { hero: [0, 0, 1, 1], goal: [0, 0, 1, 1] },
    entities: [
      { stableId: 'hero', role: 'actor', socket: 's_start', initialState: 'idle' },
      { stableId: 'goal', role: 'fixture', socket: 's_goal', initialState: 'shut' },
    ],
    rules: [{ ruleId: 'r.reach', phase: 0, priority: 0, effects: ['win'] }],
    state: { counters: { keys }, flags: { open: false } },
    witness: { ops: [{ tick: 0, actor: 'hero', actionId: 'moveTo', target: 's_goal' }] },
  };
}

/** Hotový dokument se zapečeným `simHash`. */
export function synthWorld(seed: number): WorldDoc {
  return sealSimHash({
    irVersion: WORLD_DOC_VERSION,
    simRevision: 0,
    lookRevision: 0,
    simHash: '',
    sim: simOf(seed),
    look: defaultLook(),
  });
}

export interface SynthPair {
  readonly worldA: WorldDoc;
  /** Operace nad **částí `sim`**, tedy s cestami relativními k ní. */
  readonly operations: readonly Operation[];
  /** Tentýž svět sestavený přímo, ne patchem. Oracle rovnosti. */
  readonly worldB: WorldDoc;
}

/**
 * Dvojice `(worldA, patch)` plus **přímo sestavený** `worldB`.
 *
 * `worldB` se staví nezávisle na patchi — kdyby vznikl jeho aplikací, test by
 * porovnával funkci sám se sebou a prošel by i tehdy, kdyby patch dělal něco
 * úplně jiného, než co má.
 */
export function synthPair(seed: number): SynthPair {
  const worldA = synthWorld(seed);
  const stream = createStreams(seed).effect;
  const keysAfter = nextInt(stream, 4, 9);

  const operations: readonly Operation[] = [
    { op: 'replace', path: '/state/counters/keys', value: keysAfter },
    { op: 'add', path: '/sockets/s_side', value: [2, 2] },
  ];

  // `sim` je uvnitř `unknown` (kořen je uzavřený, vnitřek otevřený — viz
  // `worlddoc.ts`), takže se tady zúží na tvar, který tenhle generátor sám vydal.
  const simA = worldA.sim as SimPart & {
    sockets: Record<string, readonly [number, number]>;
    state: Record<string, unknown>;
  };
  const simB: SimPart = {
    ...simA,
    sockets: { ...simA.sockets, s_side: [2, 2] },
    state: { ...simA.state, counters: { keys: keysAfter } },
  };

  const worldB = sealSimHash({
    ...worldA,
    sim: simB,
    simRevision: worldA.simRevision + 1,
    simHash: '',
  });

  return { worldA, operations, worldB };
}
