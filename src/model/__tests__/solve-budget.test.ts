/**
 * **Rozpočet hledání svědka — co se o něm smí tvrdit.**
 *
 * Širší hledání vypadá jako zlepšení samo od sebe, a přitom umí jen prodloužit
 * marné hledání ve světech, které stejně nikdy nevyhrají. O tom, jestli se
 * `SOLVE_BUDGET` v `src/model/repair.ts` má hnout, proto rozhoduje měření nad
 * archivem (`evals/worldstream/solve-budget.measure.ts`), ne úvaha. Tenhle test
 * měření nenahrazuje — **připíná tři vlastnosti, které se rozšířením rozpočtu
 * nesmějí ztratit**:
 *
 * 1. **Svět certifikovaný pod starým rozpočtem je certifikovaný i pod
 *    nasazeným**, a to **toutéž cestou**. Kdyby se stopa hnula, hnul by se
 *    i hash certifikátu, a to je změna důkazu, ne rozpočtu.
 * 2. **Meze zůstávají v uzlech a tikách, nikdy v čase.** `src/verify/solve.ts`
 *    stojí na tom, že prohlížeč a Node dají tutéž odpověď; hodiny to neumějí.
 *    Změřit si uplynulé milisekundy pro artefakt je v pořádku, rozhodovat podle
 *    nich uvnitř rozpočtu ne, a tenhle test to drží lexikálně nad klíči.
 * 3. **Nevyhratelný svět skončí odmítnutím, ne během.** Širší rozpočet znamená
 *    delší marné hledání; test kontroluje, že se pořád zastaví o vlastní meze.
 *
 * Světy se sem nepíšou ručně — berou se z příkladu v produkčním promptu, stejně
 * jako v `src/verify/__tests__/solve.test.ts`. Archiv (`create-raw.json`) je
 * gitignorovaný, takže v čistém klonu neexistuje a `npm test` se ho ani
 * nedotkne.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../../ir/build';
import { solveWitness, solveWitnessDetailed } from '../../verify/solve';
import { verifyWitness } from '../../verify/witness';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';
import { SOLVE_BUDGET } from '../repair';

/**
 * Rozpočet, pod kterým byly dosavadní verdikty vydané (naměřeno 16. 9. 2026,
 * P19 R6). Je tu připíchnutý schválně: je to ta laťka, pod kterou nasazený
 * rozpočet nesmí spadnout, ať se v `repair.ts` změní cokoli.
 */
const OLD_BUDGET = { maxNodes: 20_000, maxTicks: 40_000, maxDepth: 6, settleTicks: 30 } as const;

/** Jediná pole, ze kterých rozpočet smí být složený. */
const ALLOWED_LIMITS = ['maxDepth', 'maxNodes', 'maxTicks', 'settleTicks'];

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

/** Ukázkový svět z hotové systémové zprávy, tedy ten, který vidí model. */
function exampleSim(): Record<string, unknown> {
  const system = buildEmissionRequest('cokoli', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  const document = JSON.parse(system.slice(system.indexOf('{', at))) as { sim: Record<string, unknown> };
  return { ...document.sim, witness: { tier: 'short', H_cert: 600, ops: [] } };
}

function build(sim: Record<string, unknown>) {
  const built = buildRuntimeWorld(sim);
  expect(built.ok ? [] : built.issues, 'svět se nepostavil, test by měřil něco jiného').toEqual([]);
  if (!built.ok) throw new Error('unreachable');
  return built.world;
}

describe('nasazený rozpočet hledání', () => {
  it('je složený jen z uzlů a tiků — žádná mez v čase', () => {
    expect(Object.keys(SOLVE_BUDGET).sort()).toEqual(ALLOWED_LIMITS);
    for (const [key, value] of Object.entries(SOLVE_BUDGET)) {
      expect(
        /ms|milli|time|clock|second|deadline|timeout|elapsed|budgetMs/i.test(key),
        `mez ${key} se odvolává na hodiny — prohlížeč a Node by daly jinou odpověď`,
      ).toBe(false);
      expect(typeof value, `mez ${key} není číslo`).toBe('number');
      expect(value, `mez ${key} musí být kladná`).toBeGreaterThan(0);
    }
  });

  it('není užší než ten, pod kterým padly dosavadní verdikty', () => {
    expect(SOLVE_BUDGET.maxNodes).toBeGreaterThanOrEqual(OLD_BUDGET.maxNodes);
    expect(SOLVE_BUDGET.maxTicks).toBeGreaterThanOrEqual(OLD_BUDGET.maxTicks);
    expect(SOLVE_BUDGET.maxDepth).toBeGreaterThanOrEqual(OLD_BUDGET.maxDepth);
    // Delší okno mezi vstupy není rozšíření: posunulo by čas každého vstupu,
    // takže by se nalezená stopa mohla lišit i tam, kde stará prošla.
    expect(SOLVE_BUDGET.settleTicks).toBe(OLD_BUDGET.settleTicks);
  });

  it('certifikuje touž cestou svět, který certifikoval starý rozpočet', () => {
    const world = build(exampleSim());

    const before = solveWitness(world, OLD_BUDGET);
    expect(before, 'starý rozpočet příklad nevyřešil, test by neměřil regresi').not.toBeNull();

    const after = solveWitness(world, SOLVE_BUDGET);
    expect(after, 'nasazený rozpočet ztratil cestu, kterou starý našel').not.toBeNull();
    if (before === null || after === null) return;

    // Táž stopa, ne jen tentýž verdikt: z ní se hashuje certifikát.
    expect(after.ops).toEqual(before.ops);
    expect(after.wonAtTick).toBe(before.wonAtTick);
    expect(verifyWitness({ ...world, trace: after.ops }, after.ops).verdict).toBe('CERTIFIED');
  });

  it('nevyhratelný svět odmítne a zastaví se o vlastní meze', () => {
    const sim = exampleSim();
    const rules = { ...(sim.rules as Record<string, unknown>) };
    delete rules.win;
    const world = build({ ...sim, rules });

    const diagnostic = solveWitnessDetailed(world, SOLVE_BUDGET);

    expect(diagnostic.result, 'hledač vydal cestu k výhře, která ve světě není').toBeNull();
    expect(['search-exhausted', 'budget-exhausted']).toContain(diagnostic.status);
    expect(diagnostic.nodes).toBeLessThanOrEqual(SOLVE_BUDGET.maxNodes);
    expect(diagnostic.ticks).toBeLessThanOrEqual(SOLVE_BUDGET.maxTicks);
  });
});
