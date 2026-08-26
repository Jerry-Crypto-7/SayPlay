/**
 * Hledač svědka.
 *
 * Světy se **nepíšou sem**, berou se z příkladu v produkčním promptu — je to
 * přesně ten objekt, který uvidí model, takže test nekontroluje, jestli si sám
 * správně opsal schéma.
 *
 * Hlídají se tři vlastnosti, každá s vlastní cenou, když padne:
 *
 * 1. **Najde cestu tam, kde existuje.** Bez toho je celý modul k ničemu.
 * 2. **Nenajde ji tam, kde neexistuje.** Kdyby padla tahle, projde přijetím
 *    svět, který se dohrát nedá — a to je jediná dokázaná vlastnost projektu.
 * 3. **Nesnižuje laťku.** Svět, který vyhraje bez hráče, certifikát nedostane.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../../ir/build';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../../model/prompt';
import { solveWitness, inputAlphabet, actorOf } from '../solve';
import { verifyWitness } from '../witness';

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

const BUDGET = { maxNodes: 20_000, maxDepth: 6, settleTicks: 30 } as const;

/** Ukázkový svět z hotové systémové zprávy, tedy ten, který vidí model. */
function exampleSim(): Record<string, unknown> {
  const system = buildEmissionRequest('cokoli', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  const document = JSON.parse(system.slice(system.indexOf('{', at))) as { sim: Record<string, unknown> };
  // Příklad svědka nenese; obálku dosazuje produkčně opravná vrstva a tady se
  // dosadí stejně, aby se `buildRuntimeWorld` mělo čeho chytit.
  return { ...document.sim, witness: { tier: 'short', H_cert: 600, ops: [] } };
}

function build(sim: Record<string, unknown>) {
  const built = buildRuntimeWorld(sim);
  expect(built.ok ? [] : built.issues, 'svět se nepostavil, test by měřil něco jiného').toEqual([]);
  if (!built.ok) throw new Error('unreachable');
  return built.world;
}

describe('abeceda vstupů', () => {
  it('je přesně to, na co se ptá nějaké pravidlo', () => {
    const world = build(exampleSim());
    const actor = actorOf(world);
    expect(actor).toBe('player');
    if (actor === null) return;

    const moves = inputAlphabet(world, actor).map((move) => `${move.actionId} ${String(move.target)}`);
    // `moveTo` na každou entitu váže systém sám; `pickup` a `use` jsou z pravidel
    // příkladu. Nic dalšího by v tom světě neudělalo vůbec nic.
    expect(moves).toContain('moveTo gate');
    expect(moves).toContain('pickup card');
    expect(moves).toContain('use lever');
    expect(moves, 'abeceda nese vstup, na který se nikdo neptá').not.toContain('use gate');
  });

  it('nemíří na sokety, protože chůzi váže systém jen k entitám', () => {
    const world = build(exampleSim());
    const actor = actorOf(world);
    if (actor === null) return;
    const targets = new Set(inputAlphabet(world, actor).map((move) => move.target));
    for (const socket of ['spawnPad', 'cardPad', 'leverPad', 'gatePad'])
      expect(targets, `soket ${socket} se dostal do abecedy`).not.toContain(socket);
  });
});

describe('solveWitness', () => {
  it('najde vítěznou cestu pro svět, který ji má', () => {
    const world = build(exampleSim());
    const found = solveWitness(world, BUDGET);

    expect(found, 'hledač nenašel cestu ve světě, kde vede').not.toBeNull();
    if (found === null) return;
    // Vyhrát se tam dá až po sebrání karty a použití páky, takže jeden tah to být
    // nemůže — kdyby ano, hledač obchází pravidla místo aby je splnil.
    expect(found.ops.length).toBeGreaterThanOrEqual(3);
    expect(verifyWitness({ ...world, trace: found.ops }, found.ops).verdict).toBe('CERTIFIED');
  });

  it('nenajde cestu ve světě, který se vyhrát nedá', () => {
    const sim = exampleSim();
    const rules = { ...(sim.rules as Record<string, unknown>) };
    delete rules.win;
    const found = solveWitness(build({ ...sim, rules }), BUDGET);

    expect(found, 'hledač vydal cestu ke výhře, která ve světě není').toBeNull();
  });

  it('nedokazuje svět, který vyhraje bez hráče', () => {
    const sim = exampleSim();
    const rules = {
      ...(sim.rules as Record<string, unknown>),
      win: { phase: 0, priority: 0, event: { kind: 'onStart' }, condition: null, actions: [{ kind: 'win' }] },
    };
    const found = solveWitness(build({ ...sim, rules }), BUDGET);

    expect(found, 'hledač certifikoval svět, ve kterém hráč není potřeba').toBeNull();
  });

  it('respektuje rozpočet a vrátí null místo aby běžel dál', () => {
    const found = solveWitness(build(exampleSim()), { maxNodes: 1, maxDepth: 6, settleTicks: 30 });

    expect(found, 'hledač si vzal víc uzlů, než dostal').toBeNull();
  });

  it('dá dvakrát tutéž cestu, protože se z ní hashuje certifikát', () => {
    const world = build(exampleSim());
    const first = solveWitness(world, BUDGET);
    const second = solveWitness(world, BUDGET);

    expect(first?.ops).toEqual(second?.ops);
  });
});
