/**
 * Kritik (P23-B T5). Kritik, který nikdy nic nenajde, vypadá jako čistý spec –
 * proto se drží nula blokujících nálezů nad 16 dobrými spec a devět cílených
 * mutací, každá na jeden kód. Balíčkové `ASSET_BLOCKING` / `NO_RECOVERY` se
 * nevydávají nikdy a výstup nikdy nenese skóre.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../evals/play/golden';
import sentenceSet from '../../../evals/play/p32/sentences.json';
import { GOOD_ANSWERS, answerFixture } from '../director/__fixtures__';
import { CRITIC_CODES, UNISSUED_PACK_CODES, blockingIssues, critique, fidelity, saidIn, type CriticIssue, type FidelityIssue } from '../director/critic';
import { DIRECTOR_EXAMPLES, exampleSpec } from '../director/retrieval';
import { draftGameSpecWithMeta } from '../draft';
import { genreDoubles } from '../genre/__tests__/doubles';
import type { CastRole, GenreSpec } from '../genre/contract';
import { ARCHETYPE_IDS } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

it('accepts a singular switch from the explicitly named switches', () => {
  expect(saidIn('switch', 'Toggle the switches to open the gate')).toBe(true);
  expect(saidIn('dragon', 'Toggle the switches to open the gate')).toBe(false);
});

function base(name: string): GameSpecV1 {
  const result = readGameSpec(JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8')));
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.value;
}

function good(name: (typeof GOOD_ANSWERS)[number]): GameSpecV1 {
  const result = readGameSpec(answerFixture(name));
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function codes(issues: readonly CriticIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

const PACK_CODES = readFileSync(fileURLToPath(new URL('../../../docs/play/pack/critic.md', import.meta.url)), 'utf8');

describe('critique', () => {
  it('issues only pack codes, never ASSET_BLOCKING or NO_RECOVERY', () => {
    for (const code of [...CRITIC_CODES, ...UNISSUED_PACK_CODES]) expect(PACK_CODES).toContain(code);
    for (const code of UNISSUED_PACK_CODES) expect(CRITIC_CODES as readonly string[]).not.toContain(code);
  });

  it('raises no blocking issue over the eight base fixtures and the eight good answers', () => {
    for (const id of ARCHETYPE_IDS) expect(blockingIssues(critique(base(id))), id).toEqual([]);
    for (const name of GOOD_ANSWERS) expect(blockingIssues(critique(good(name))), name).toEqual([]);
  });

  it('never outputs a score – no key or code mentions score or fun', () => {
    for (const name of GOOD_ANSWERS) {
      for (const issue of critique(good(name))) {
        expect(Object.keys(issue).join(' ')).not.toMatch(/score|fun/i);
        expect(issue.code).not.toMatch(/score|fun/i);
      }
    }
  });

  it('NO_AGENCY: a timer alone blocks', () => {
    const spec = clone(base('survival_timer'));
    spec.mechanics = spec.mechanics.filter((m) => m.id !== 'hazard_zone');
    spec.verification = spec.verification.filter((v) => v.mechanic !== 'hazard_zone');
    expect(codes(blockingIssues(critique(spec)))).toEqual(['NO_AGENCY']);
  });

  it('NO_TERMINATION: a zone that only signals leaves no way to win', () => {
    const spec = clone(base('collect_exit'));
    (spec.mechanics[1].params as { effect: string }).effect = 'signal';
    expect(codes(blockingIssues(critique(spec)))).toEqual(['NO_TERMINATION']);
  });

  it('CONTRADICTION: objective.count against collectible.count, and required outside switchRoles', () => {
    const spec = clone(base('collect_exit'));
    spec.objective.count = 6;
    const issues = blockingIssues(critique(spec));
    expect(codes(issues)).toEqual(['CONTRADICTION']);
    expect(issues[0].path).toBe('/mechanics/0/params/count');

    const puzzle = clone(base('switch_puzzle'));
    (puzzle.mechanics[0].params as { required: string[] }).required = ['red', 'purple'];
    expect(codes(blockingIssues(critique(puzzle)))).toEqual(['CONTRADICTION']);
  });

  it('TOO_COMPLEX: thirteen roles block', () => {
    const spec = clone(base('chase_escape'));
    for (let i = 0; i < 9; i += 1) spec.roles.push({ id: `prop${String(i)}`, kind: 'prop', label: `crate ${String(i)}`, count: 1 });
    expect(codes(blockingIssues(critique(spec)))).toEqual(['TOO_COMPLEX']);
  });

  it('UNFAIR_SPAWN: a fast chaser with no stun and no checkpoint blocks', () => {
    const spec = clone(base('chase_escape'));
    (spec.mechanics[0].params as { speed: string }).speed = 'fast';
    spec.mechanics = spec.mechanics.filter((m) => m.id !== 'stun');
    spec.verification = spec.verification.filter((v) => v.mechanic !== 'stun');
    expect(codes(blockingIssues(critique(spec)))).toEqual(['UNFAIR_SPAWN']);
  });

  it('DEAD_TIME, GOAL_UNCLEAR, UNVERIFIABLE, UNSUPPORTED and BUDGET warn without blocking', () => {
    const slow = clone(base('switch_puzzle'));
    slow.targetDurationSec = 150;
    expect(codes(critique(slow))).toContain('DEAD_TIME');
    expect(blockingIssues(critique(slow))).toEqual([]);

    const vague = clone(base('collect_exit'));
    vague.objective.description = 'Collect the mushrooms and leave.';
    expect(codes(critique(vague))).toContain('GOAL_UNCLEAR');
    expect(blockingIssues(critique(vague))).toEqual([]);

    const unverified = clone(base('collect_exit'));
    unverified.verification = unverified.verification.filter((v) => v.mechanic !== 'collectible');
    const issue = critique(unverified).find((entry) => entry.code === 'UNVERIFIABLE');
    expect(issue?.path).toBe('/mechanics/0');
    expect(blockingIssues(critique(unverified))).toEqual([]);

    const fantasy = clone(base('combat_lite'));
    fantasy.objective.description = 'Shoot all five slimes with energy balls.';
    expect(critique(fantasy).find((entry) => entry.code === 'UNSUPPORTED')?.severity).toBe('warn');

    const tight = clone(base('collect_exit'));
    tight.budgets.maxEntities = 8;
    expect(critique(tight).find((entry) => entry.code === 'BUDGET')?.severity).toBe('warn');
  });
});

/**
 * Kontrola věrnosti žánrové odpovědi (P32B T5) nad dvojníky modulů. Kontrola,
 * která nic nenajde, pustí pirátskou loď do auta – proto na každý kód jedna
 * odpověď mimo větu, a draft každé věty sady jako odpověď, která projde.
 */
describe('fidelity of a GenreSpec answer', () => {
  const modules = genreDoubles();
  const text = (id: string): string => sentenceSet.sentences.find((entry) => entry.id === id)!.text;
  const codes = (genre: GenreSpec, id: string, options = { modules }): string[] => fidelity(genre, text(id), options).map((issue) => issue.code);

  it('passes the draft of every sentence of the set', () => {
    for (const { id } of sentenceSet.sentences) {
      const genre = draftGameSpecWithMeta(text(id), 1, { modules }).genre;
      expect(genre, id).not.toBeNull();
      expect(codes(genre!, id), id).toEqual([]);
    }
  });

  it('refuses a pirate ship as the hero of a runner', () => {
    expect(codes({ genre: 'runner', mode: 'default', hero: 'pirate ship', setting: 'ocean' }, 'pirate')).toContain('HERO_UNFIT');
  });

  it('refuses a race car where the sentence sails a pirate ship', () => {
    expect(codes({ genre: 'voyage', mode: 'race', hero: 'race car', setting: 'ocean' }, 'pirate')).toContain('HERO_NOT_SAID');
  });

  it('refuses a voyage for a wizard who lights candles', () => {
    expect(codes({ genre: 'voyage', mode: 'race', hero: 'wizard', cast: [{ label: 'candle', does: 'collect' }], setting: 'haunted castle' }, 'wizard')).toContain('VERB_OUTSIDE_MODE');
  });

  it('refuses a cast thing that is neither in the sentence nor a default of the setting', () => {
    const cat = draftGameSpecWithMeta(text('cat'), 1, { modules }).genre!;
    const roomba = { label: 'giant Roomba', does: 'chase_me' } as const;
    // Roomba místo ledního medvěda: vymyšlená věc a chybějící věc věty, každá svým nálezem.
    const swapped = fidelity({ ...cat, cast: [roomba, ...cat.cast!.filter((item) => item.label !== 'polar bear')] }, text('cat'), { modules });
    expect(swapped.map((issue) => [issue.code, issue.path])).toEqual([['CAST_NOT_SAID', '/cast/0'], ['CAST_MISSING', '/cast']]);
    expect(swapped[1]!.thing).toMatchObject({ label: 'polar bear', does: 'chase_me' });
    const knights = draftGameSpecWithMeta(text('knights'), 1, { modules }).genre!;
    expect(codes({ ...knights, cast: [{ label: 'dragon', does: 'fight' }] }, 'knights')).toContain('CAST_NOT_SAID');
    // Věta bez nepřítele: projde jen výchozí nepřítel prostředí (město → auto), vzorová Roomba ne.
    const dog = { genre: 'voyage', mode: 'race', hero: 'dog', setting: 'city' } as const;
    expect(codes({ ...dog, cast: [{ label: 'car', does: 'avoid' }] }, 'dog')).toEqual([]);
    expect(codes({ ...dog, cast: [{ label: 'giant Roomba', does: 'avoid' }] }, 'dog')).toEqual(['CAST_NOT_SAID']);
    // Každá role, ne jen nepřítel: vymyšlená věc ke sběru i cíl. Kulisa z místa odpovědi projde.
    expect(codes({ ...dog, cast: [{ label: 'golden bone', does: 'collect' }] }, 'dog')).toEqual(['CAST_NOT_SAID']);
    expect(codes({ ...dog, cast: [{ label: 'lighthouse', does: 'reach', verb: 'reach', states: 2 }] }, 'dog')).toEqual(['CAST_NOT_SAID']);
    expect(codes({ ...dog, setting: 'city park with a fountain', cast: [{ label: 'fountain', does: 'scenery' }] }, 'dog')).toEqual([]);
  });

  // P39 (oprava `critic.ts:413` třídou): AI smí obsadit věc věty, kterou rychlá verze nemá – soudí se věta, ne rychlá verze.
  it('keeps a cast thing the sentence says even when the quick version does not have it', () => {
    const real = 'a fox jumps over logs while animals watch in the forest';
    const quick = draftGameSpecWithMeta(real).genre!;
    expect(quick.genre).toBe('platformer');
    expect(quick.cast!.map((item) => item.label)).not.toContain('animal');
    const written: GenreSpec = { ...quick, cast: [...quick.cast!, { label: 'animals', does: 'shoot_at' }] };
    expect(fidelity(written, real)).toEqual([]);
    // Tatáž věc mimo větu (vlk je výchozí v lese, medvěd ne) neprojde.
    expect(fidelity({ ...quick, cast: [...quick.cast!, { label: 'bear', does: 'shoot_at' }] }, real).map((issue) => issue.code)).toEqual(['CAST_NOT_SAID']);
    expect(fidelity({ ...quick, cast: [...quick.cast!, { label: 'wolf', does: 'shoot_at' }] }, real)).toEqual([]);
  });

  // P39: role musí sedět ke slovesu, které k věci ve větě patří – co se střílí, není překážka.
  it('refuses a role that does not fit the verb the sentence gives the thing', () => {
    const shoot = 'a robot jumps across factory platforms and shoots rust bugs';
    const quick = draftGameSpecWithMeta(shoot).genre!;
    expect(quick.cast).toContainEqual({ label: 'rust bug', does: 'shoot_at' });
    const as = (does: CastRole): FidelityIssue[] => fidelity({ ...quick, cast: [{ label: 'rust bug', does }] }, shoot);
    for (const does of ['avoid', 'chase_me', 'collect', 'scenery'] as const) {
      expect(as(does), does).toEqual([expect.objectContaining({ code: 'CAST_ROLE_WRONG', path: '/cast/0', thing: { label: 'rust bug', does: 'shoot_at' } })]);
    }
    // Útok je útok: žánr, který nestřílí, hraje střílenou věc jako soupeře nebo terč.
    for (const does of ['shoot_at', 'fight', 'throw_at'] as const) expect(as(does), does).toEqual([]);
    // Co sbírá, se nehoní; cíl úkolu je předmět slovesa a sedí ke sběru i k útoku.
    const fish = text('cat');
    const cat = draftGameSpecWithMeta(fish, 1, { modules }).genre!;
    const fishAs = (does: CastRole): string[] => fidelity({ ...cat, cast: cat.cast!.map((item) => (item.label === 'glowing fish' ? { ...item, does } : item)) }, fish, { modules }).map((issue) => issue.code);
    expect(fishAs('chase_me')).toEqual(['CAST_ROLE_WRONG']);
    expect(fishAs('reach')).toEqual([]);
    expect(fidelity({ ...quick, cast: [{ label: 'rust bug', does: 'reach', verb: 'hit', states: 2 }] }, shoot)).toEqual([]);
  });

  // Nad skutečnými moduly (B-R7): 2 z 249 vět, kde hlavní sloveso hraje jiný režim než první v pořadí.
  it('proves the mode the main verb plays, not the first mode of the ranking', () => {
    const swords = 'merge swords to make stronger swords and fight monsters';
    const verbCodes = (genre: GenreSpec) => fidelity(genre, swords).filter((issue) => issue.code === 'VERB_OUTSIDE_MODE');
    expect(verbCodes({ genre: 'quest', mode: 'station', hero: 'fox', cast: [{ label: 'sword', does: 'reach', verb: 'make', states: 3 }], setting: 'meadow' })).toEqual([]);
    expect(verbCodes({ genre: 'arena', mode: 'fight', hero: 'fox', cast: [{ label: 'monster', does: 'fight' }], setting: 'meadow' })).toHaveLength(1);
  });

  // P38: věta, ve které tabulka sloves nic nenajde (česky), žánr nedokazuje – režisér ho vybere sám,
  // jinak by ho kontrola vrátila k náhradní Aréně draftu.
  it('lets the director pick the genre when the sentence has no verb the table knows', () => {
    const czech = 'skákací hra se střílením do zvířat v lese';
    const verbCodes = (genre: GenreSpec) => fidelity(genre, czech).filter((issue) => issue.code === 'VERB_OUTSIDE_MODE');
    expect(verbCodes({ genre: 'platformer', mode: 'default', hero: 'fox', cast: [{ label: 'wolf', does: 'shoot_at' }], setting: 'forest' })).toEqual([]);
    // Zvíře z věty slova nepřečtou, takže ho kontrola nesmí shodit jako vymyšlené.
    expect(fidelity({ genre: 'platformer', mode: 'default', hero: 'hunter', cast: [{ label: 'deer', does: 'shoot_at' }], setting: 'forest' }, czech)).toEqual([]);
    // Věta se slovesem z tabulky dál dokazuje režim.
    expect(fidelity({ genre: 'arena', mode: 'fight', hero: 'fox', cast: [{ label: 'wolf', does: 'fight' }], setting: 'forest' }, 'a fox jumps over logs in the forest').map((issue) => issue.code)).toContain('VERB_OUTSIDE_MODE');
  });

  // Rychlá verze je poslední záloha opravy (`switchGenre` bere její věci): kontrola, která by shodila
  // i ji, by AI verzi poslala zpátky na návrh. Nad skutečnými moduly, 300 vět zlaté, poptávkové a vývojové sady.
  const demand = JSON.parse(readFileSync('evals/play/demand/corpus.json', 'utf8')) as { readonly text: string }[];
  const dev = JSON.parse(readFileSync('evals/play/p30/dev.json', 'utf8')) as { readonly sentences: { readonly text: string }[] };
  const castSentences = [...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text), ...dev.sentences.map((entry) => entry.text)];
  it('keeps all 300 golden, demand and dev cast cases', () => expect(castSentences).toHaveLength(300));
  it.each(castSentences)('passes the quick cast: %s', sentence => {
    const genre = draftGameSpecWithMeta(sentence).genre;
    if (genre === null || genre === undefined) return;
    expect(fidelity(genre, sentence).filter((issue) => issue.code.startsWith('CAST_')), sentence).toEqual([]);
  });

  // Příklady jdou do promptu jako vzor tvaru (`retrieval.ts`): obsazení, které by kritik shodil, by model učil chybu.
  it('passes the cast of every director example', () => {
    for (const example of DIRECTOR_EXAMPLES) {
      const cast = fidelity(exampleSpec(example), example.sentence).filter((issue) => issue.code.startsWith('CAST_'));
      expect(cast, example.id).toEqual([]);
    }
  });

  it('refuses a mode that only plays a stand-in, and then proves the best ready mode', () => {
    const stand = { modules: genreDoubles(['quest.spatial', 'quest.station']) };
    const chef = { genre: 'quest', mode: 'station', hero: 'chef', target: { label: 'pancake', verb: 'cook', states: 3 }, setting: 'kitchen' } as const;
    expect(codes(chef, 'chef', stand)).toContain('MODE_NOT_READY');
    const wizard = draftGameSpecWithMeta(text('wizard'), 1, stand).genre!;
    expect(`${wizard.genre}.${wizard.mode}`).toBe('arena.escape');
    expect(codes(wizard, 'wizard', stand)).toEqual([]);
  });
});
