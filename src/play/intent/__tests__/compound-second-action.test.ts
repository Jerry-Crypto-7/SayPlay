import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import type { IntentTriple } from '../contract';

// Druhá akce souvětí se buď zahraje (svědek), nebo se poctivě ohlásí v
// `honesty.unmet` – nikdy tiše nezmizí. Věty se skládají ze šablon s vlastními
// slovy, ne z žádné měřené sady.
beforeAll(async () => { await loadRapier(); });

const SUBJECTS = [
  { noun: 'hedgehog', first: 'scurries across the meadow' },
  { noun: 'astronaut', first: 'drifts through the station' },
] as const;
const SECOND = [
  { verb: 'collect', phrase: 'gathers berries', bare: 'gather berries', ing: 'gathering berries', rel: 'with berries to gather', object: 'berry' },
  { verb: 'escape', phrase: 'escapes', bare: 'escape', ing: 'escaping', rel: null, object: null },
  { verb: 'catch', phrase: 'catches beetles', bare: 'catch beetles', ing: 'catching beetles', rel: 'with beetles to catch', object: 'beetle' },
  { verb: 'throw', phrase: 'throws pebbles', bare: 'throw pebbles', ing: 'throwing pebbles', rel: 'with pebbles to throw', object: 'pebble' },
  { verb: 'reach', phrase: 'reaches the tower', bare: 'reach the tower', ing: 'reaching the tower', rel: 'with a tower to reach', object: 'tower' },
  { verb: 'land', phrase: 'lands', bare: 'land', ing: 'landing', rel: null, object: null },
  { verb: 'deliver', phrase: 'delivers parcels', bare: 'deliver parcels', ing: 'delivering parcels', rel: 'with parcels to deliver', object: 'parcel' },
] as const;
const JOINS = [
  (first: string, second: (typeof SECOND)[number]) => `${first} and ${second.phrase}`,
  (first: string, second: (typeof SECOND)[number]) => `${first}, then ${second.phrase}`,
  (first: string, second: (typeof SECOND)[number]) => `${first} to ${second.bare}`,
  (first: string, second: (typeof SECOND)[number]) => `${first} and then ${second.phrase}`,
  (first: string, second: (typeof SECOND)[number]) => `${first}, ${second.ing}`,
  (first: string, second: (typeof SECOND)[number]) => `${first}, dodges owls, and ${second.phrase}`,
  // Předmět ve vztažné vazbě („s X k chycení“) nesmí z akce vypadnout.
  (first: string, second: (typeof SECOND)[number]) => second.rel && `${first} ${second.rel}`,
];
const CASES = SUBJECTS.flatMap((subject) => SECOND.flatMap((second) => JOINS.flatMap((join) => {
  const clause = join(subject.first, second);
  return clause ? [{ sentence: `A ${subject.noun} ${clause}.`, triple: { actor: subject.noun, verb: second.verb, object: second.object } as IntentTriple }] : [];
})));
const same = (a: IntentTriple, b: IntentTriple) => a.actor === b.actor && a.verb === b.verb && a.object === b.object;

describe('the second action of a compound sentence is played or admitted', () => {
  it('covers 7 verbs × 6 joins (+ 5 object verbs in a relative) × 2 subjects', () => {
    expect(CASES).toHaveLength(2 * (7 * 6 + 5));
  });

  it.each(CASES)('$sentence', async ({ sentence, triple }) => {
    vi.stubEnv('PLAY_READER', 'off');
    try {
      const { spec } = draftGameSpecWithMeta(sentence, 1);
      const made = arcadeWorldOf(spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const witnesses = verifyArcade(made.world, undefined, made.roleBindings).witnesses;
      const unmet = (await honestyForSpec(sentence, spec, 1, made.world))?.unmet ?? [];
      const played = witnesses.some((witness) => matchesWitness(triple, witness));
      const admitted = unmet.some((item) => same(item, triple));
      expect(played || admitted, `${triple.verb}/${triple.object} silently dropped; unmet=${JSON.stringify(unmet)}`).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);

  it('no measured round6 sentence is written into the reader or the composer', () => {
    const corpus = JSON.parse(readFileSync('evals/play/p42/round6/sentences.json', 'utf8')) as { groups: Record<string, { sentence: string }[]> };
    const sentences = Object.values(corpus.groups).flat().map((row) => row.sentence.toLowerCase().replace(/\.$/, ''));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
    for (const file of [...files('src/play/intent'), ...files('src/play/compose')]) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const sentence of sentences) expect(text.includes(sentence), `${file} quotes "${sentence}"`).toBe(false);
    }
  });
});
