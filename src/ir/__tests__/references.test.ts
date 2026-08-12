import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findDanglingReferences } from '../references';

function frozenLines(...parts: string[]): Record<string, any>[] {
  return readFileSync(join(process.cwd(), 'evals', 'frozen', ...parts), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

const malformed = frozenLines('malformed', 'index.jsonl');
const responses = frozenLines('responses', 'index.jsonl');

/** Zmrazená třída defektu „osiřelý odkaz". Je jich málo — a to je důvod je jmenovat. */
const DANGLING = malformed.filter((entry) => entry.defectClass === 'dangling_reference');

describe('osiřelé odkazy ve zmrazených vadných emisích', () => {
  it('třída dangling_reference není prázdná', () => {
    expect(DANGLING.length).toBeGreaterThan(0);
  });

  it.each(DANGLING.map((entry) => [entry.id, entry] as const))(
    '%s je nahlášen a jmenuje symbol ze své anotace',
    (_id, entry) => {
      const found = findDanglingReferences(entry.body);
      expect(found.length).toBeGreaterThan(0);
      // Nestačí, že něco spadlo — musí spadnout na tom jméně, které `defect`
      // pojmenovává. Jinak by test prošel i resolveru, který hlásí všechno.
      for (const reference of found) {
        expect(entry.defect).toContain(reference.name);
      }
    },
  );
});

/**
 * Bez týhle kontroly by testem prošel i resolver, který hlásí příliš. Vyloučeny
 * jsou jen `NO_FIT` emise, protože ty podle protokolu `sim` vůbec nenesou.
 */
describe('negativní kontrola nad zmrazenými syntetickými odpověďmi', () => {
  const worlds = responses.filter((entry) => entry.branch === 'create' && entry.expectedVerdict !== 'NO_FIT');

  it('pokrývá všechny zmrazené světy tvorby, které simulaci nesou', () => {
    expect(worlds).toHaveLength(13);
    expect(worlds.every((entry) => entry.body?.sim)).toBe(true);
  });

  it.each(worlds.map((entry) => [entry.forPrompt, entry] as const))(
    '%s nemá jediný osiřelý odkaz',
    (_prompt, entry) => {
      expect(findDanglingReferences(entry.body)).toEqual([]);
    },
  );
});

describe('rozpouštění jmen', () => {
  const world: Record<string, any> = {
    sim: {
      sockets: { s0: [1, 1] },
      entities: { player: { role: 'actor', socket: 's0', state: 'idle' } },
      state: { counters: { score: { min: 0, max: 9, init: 0 } }, flags: {}, timers: {} },
      rules: [
        {
          id: 'win',
          event: { kind: 'onCounterReaches', ref: 'score', threshold: 3 },
          condition: null,
          actions: [{ kind: 'win' }],
        },
      ],
      witness: { ops: [] },
    },
    look: { modules: { player: { family: 'actor', params: {} } } },
  };

  it('deklarovaný dokument projde', () => {
    expect(findDanglingReferences(world)).toEqual([]);
  });

  it('pravidlo nad nedeklarovaným counterem je osiřelý odkaz', () => {
    const broken = structuredClone(world);
    broken.sim.rules[0].event.ref = 'coins';
    expect(findDanglingReferences(broken)).toEqual([
      { where: 'sim.rules[win].event.ref', namespace: 'counter', name: 'coins' },
    ]);
  });

  it('vzhledový modul bez odpovídající entity je osiřelý odkaz', () => {
    const broken = structuredClone(world);
    broken.look.modules.lamp = { family: 'fixture', params: {} };
    expect(findDanglingReferences(broken)).toEqual([
      { where: 'look.modules.lamp', namespace: 'entity', name: 'lamp' },
    ]);
  });
});
