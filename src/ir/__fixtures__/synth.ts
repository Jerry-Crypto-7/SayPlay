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

/**
 * Systémový default vzhledu. V P1 ho emituje SYSTÉM, ne model (`p1Status`).
 *
 * **Tvar se drží zmrazeného korpusu, ne vlastní představy.** Schéma má vnitřek
 * otevřený, takže by rozdíl nikdo nechytil — a přesně takhle se do minulého kola
 * dostalo `layout.type` proti korpusovému `layout.kind`. Fixtura je to, co příští
 * autor zkopíruje; když se rozejde s korpusem, rozejde se i on.
 */
export function defaultLook(): LookPart {
  return {
    modules: { hero: { family: 'actor', params: { height: 1.8 } } },
    palette: 'slate',
    lightRig: 'key',
    atmosphere: 'none',
    materialRoles: {},
    camera: { kind: 'orbit' },
    audio: {},
  };
}

function simOf(seed: number): SimPart {
  const stream = createStreams(seed).layout;
  const width = nextInt(stream, 4, 12);
  const height = nextInt(stream, 4, 12);
  const keys = nextInt(stream, 1, 3);

  // Jména polí jsou z korpusu: `layout.kind` (ne `type`), `grid.cell` (ne
  // `width`/`height`), `entities` jako ZÁZNAM (ne pole), svědek s tierem a mezemi.
  //
  // **`rules` je ZÁZNAM klíčovaný stabilním `id`, ne pole** — to je tvar po
  // přemrazení na `evals-frozen-v2`. Pole tady zůstalo jako jedno ze dvou míst
  // v repu, která si s kanonickým tvarem odporovala (druhé byly fixtury
  // v `__tests__/references.test.ts`), a je to přesně ta vada, kvůli které
  // se korpus mrazil znovu: editační patche adresují pravidla jménem
  // (`/sim/rules/open/condition/op`), zatímco pole se indexuje číslem, a vložení
  // nebo smazání pravidla u pole posune indexy všem ostatním, takže patch tiše
  // trefí jiné pravidlo. `id` uvnitř pravidla se **rovná klíči**, protože to tak
  // má korpus — `ruleEntries` v `references.ts` na tom nestojí, u záznamu adresuje
  // klíčem a `rule.id` čte jen ve větvi pro pole.
  return {
    layout: { kind: 'grid', width, height, levels: 1, portals: [] },
    grid: { cell: 1 },
    sockets: { spawn: [1, 1], exit: [width - 1, height - 1] },
    collisionAabb: { player: [1, 1, 1, 1], exit: [width - 1, height - 1, 1, 1] },
    entities: {
      player: { role: 'actor', socket: 'spawn', state: 'idle' },
      exit: { role: 'goal', socket: 'exit', state: 'closed', locked: true },
    },
    rules: {
      win: {
        id: 'win',
        phase: 0,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'player', zone: 'exit' },
        condition: null,
        actions: [{ kind: 'win' }],
      },
    },
    state: { counters: { keys: { min: 0, max: 3, init: keys } }, flags: {}, timers: {}, slots: 3 },
    witness: {
      tier: 'short',
      H_cert: 600,
      L_witness: 40,
      K_input: 1,
      ops: [{ tick: 0, actionId: 'moveTo', target: 'exit' }],
    },
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
    { op: 'replace', path: '/state/counters/keys/init', value: keysAfter },
    { op: 'add', path: '/sockets/side', value: [2, 2] },
  ];

  // `sim` je uvnitř `unknown` (kořen je uzavřený, vnitřek otevřený — viz
  // `worlddoc.ts`), takže se tady zúží na tvar, který tenhle generátor sám vydal.
  const simA = worldA.sim as SimPart & {
    sockets: Record<string, readonly [number, number]>;
    state: { counters: { keys: Record<string, number> }; [key: string]: unknown };
  };
  const simB: SimPart = {
    ...simA,
    sockets: { ...simA.sockets, side: [2, 2] },
    state: {
      ...simA.state,
      counters: { keys: { ...simA.state.counters.keys, init: keysAfter } },
    },
  };

  const worldB = sealSimHash({
    ...worldA,
    sim: simB,
    simRevision: worldA.simRevision + 1,
    simHash: '',
  });

  return { worldA, operations, worldB };
}
