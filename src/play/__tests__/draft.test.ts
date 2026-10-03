/**
 * Návrh ze slov (P23-B T2). Návrh, který u každé věty tiše spadne na tutéž
 * fixturu, by vypadal zeleně – proto se drží trefa archetypu, čísla z věty
 * a **nulový** počet pádů na fixturu, všechno jako pin skutečného čísla
 * naměřeného 20. 9. 2026 (32/32 s archetypem, 8/8 bucketových vět CSV).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { goldenPrompts, packBucketPrompts } from '../../../evals/play/golden';
import sentenceSet from '../../../evals/play/p32/sentences.json';
import { draftForControl, draftGameSpec, draftGameSpecWithMeta, readNumbers, readRoles } from '../draft';
import { withoutPossessor } from '../draft/lexicon';
import { type ChecklistEntry, fidelityChain } from '../fidelity/chain';
import { genreDoubles } from '../genre/__tests__/doubles';
import { type GameSpecV1, readGameSpec } from '../spec';

const corpus = goldenPrompts();
const demand = JSON.parse(readFileSync('evals/play/demand/corpus.json', 'utf8')) as { readonly id: string; readonly text: string }[];
const fidelitySet = (file: string) =>
  (JSON.parse(readFileSync(`evals/play/fidelity/${file}`, 'utf8')) as { sentences: { id: string; text: string; checklist: ChecklistEntry[] }[] }).sentences;
const baseline = JSON.parse(readFileSync('evals/play/p30b/losses.json', 'utf8')) as { rows: { source: string; id: string; item: string; role: string; drawn: boolean }[] };
// Střílečka a hod jsou od P36A T10 zase žánry, poletování, načasování, rytmus a souboj od T11; žánr nemá jen `tap_go`.
const LEGACY_CONTROLS = ['tap_go'];

describe('draftGameSpecWithMeta through the genres (P32B T2)', () => {
  it.each(sentenceSet.sentences)('gives $id the genre, mode and hero the sentence says', (entry) => {
    const [genre, mode] = entry.genre.split('.');
    const meta = draftGameSpecWithMeta(entry.text, 1, { modules: genreDoubles() });
    expect(meta.fellBack).toBe(false);
    expect(meta.genre).toMatchObject({ genre, ...(mode === undefined ? {} : { mode }) });
    expect(meta.genre?.hero).toContain(entry.hero);
    expect(meta.spec.genre).toMatchObject({ id: genre });
    expect(meta.spec.roles.find((role) => role.kind === 'player')?.label).toBe(meta.genre?.hero);
    expect(meta.genreWhy).not.toBe('');
  });

  it('reads the object of a quest verb and the pursuer named after “before”', () => {
    const wizard = draftGameSpecWithMeta('A tiny wizard rides a broom through a haunted castle and must light five candles before the ghosts catch him', 1, { modules: genreDoubles() }).genre;
    expect(wizard).toMatchObject({ target: { label: 'candle', verb: 'light', states: 2 }, enemy: 'ghost' });
    const chef = draftGameSpecWithMeta('A chef cooks pancakes', 1, { modules: genreDoubles() }).genre;
    expect(chef).toMatchObject({ target: { label: 'pancake', verb: 'cook', states: 3 }, setting: 'kitchen' });
    expect(draftGameSpecWithMeta('Two knights duel in a castle', 1, { modules: genreDoubles() }).genre).toMatchObject({ hero: 'knight', enemy: 'knight' });
  });

  // Revize fáze 3, nález 2: „two knights“ je hrdina a jeden soupeř, ne rytíř proti dvěma. Od P36A T11 hraje souboj žánr Souboj.
  it('two knights duel one against one: the counted subject is not a count of rivals', () => {
    const duel = draftGameSpecWithMeta('Two knights duel in a castle', 1);
    expect(duel.genre).toMatchObject({ genre: 'duel', mode: 'default', hero: 'knight', enemy: 'knight' });
    expect(duel.genre?.counts?.enemy).toBeUndefined();
    expect(duel.spec.roles.filter((role) => role.label === 'knight').map((role) => role.count ?? 1)).toEqual([1, 1]);
    // Číslovka před soupeřem, který není podmět, dál platí.
    expect(draftGameSpecWithMeta('A knight fights three wolves in a castle', 1).genre?.counts?.enemy).toBe(3);
  });

  it('drafts every corpus sentence through a genre module, never onto a legacy control', () => {
    for (const sentence of [...corpus.map((entry) => entry.prompt), ...demand.map((entry) => entry.text)]) {
      const meta = draftGameSpecWithMeta(sentence, 1);
      expect(meta.fellBack, sentence).toBe(false);
      expect(meta.genre, sentence).not.toBeNull();
      expect(meta.spec.genre?.id, sentence).toBe(meta.genre?.genre);
      expect(LEGACY_CONTROLS, sentence).not.toContain(meta.spec.control);
    }
  });

  // Kreslení žánrové hry patří modulu (P32B T6); draft musí hrdinu a položku z věty aspoň zapsat.
  it('names every hero and item the template draft drew in the P30B baseline', () => {
    const fidelity = [...fidelitySet('corpus.json'), ...fidelitySet('judge-10.json')];
    const drew = baseline.rows.filter((row) => row.source === 'draft' && row.drawn && (row.role === 'hero' || row.role === 'item'));
    expect(drew.length).toBe(44);
    const missing = drew.filter((row) => {
      const sentence = fidelity.find((entry) => entry.id === row.id)!;
      const slots = row.role === 'hero' ? ['hero'] : ['role', 'any'];
      const entry = sentence.checklist.find((item) => item.item === row.item && slots.includes(item.slot))!;
      return !fidelityChain(draftGameSpec(sentence.text), [entry])[0]!.inSpec;
    });
    expect(missing.map((row) => `${row.id}|${row.item}`)).toEqual([]);
  });

  it('keeps the archetype and control templates for remixes of saved legacy games', () => {
    const collect = grid('Collect five glowing mushrooms then open a portal');
    expect(collect.archetype).toBe('collect_exit');
    expect(collect.control ?? 'tap_go').toBe('tap_go');
    expect(draftForControl('zombie shooter in a mall', 'shooter')?.control).toBe('shooter');
    expect(draftForControl('zombie shooter in a mall', 'shooter')?.genre).toBeUndefined();
  });

  // B-R4: čtyři pravidla role a místa, bez kterých draft dál vypadá rozumně – po jedné větě, kde pravidlo mění výstup.
  describe('keeps roles and place apart', () => {
    const genre = (sentence: string) => draftGameSpecWithMeta(sentence, 1).genre!;

    it('never collects a pronoun', () => {
      expect(genre(sentenceSet.sentences.find((entry) => entry.id === 'wizard')!.text).collectible).not.toBe('him');
      expect(genre('Escape the flooded subway before the security drone catches you.').collectible).not.toBe('you');
    });

    // Od P36A T10 je „zombie shooter“ Střílečka: zombíci jdou ve vlnách jako nepřítel, terč střelnice je jiná role.
    it('does not make the enemy of a shooter its target too', () => {
      const zombie = genre('zombie shooter in a mall');
      expect(zombie).toMatchObject({ genre: 'shooter', enemy: 'zombie' });
      expect(zombie.target?.label).not.toBe('zombie');
    });

    it('does not set the game in a phrase that names one of its roles', () => {
      const log = genre('knife throwing at a spinning log');
      expect(log.target?.label).toBe('spinning log');
      expect(log.setting).not.toBe('spinning log');
    });

    // B-R1: „farmer's dog“ se dělením slov rozlomil na roli „s dog“ – v cíli i na liště cílů.
    it('keeps a possessive whole instead of making "s dog" a role', () => {
      const fox = draftGameSpecWithMeta("A fox steals eggs from a farm while the farmer's dog chases it", 1);
      expect(["farmer's dog", 'dog']).toContain(fox.genre!.enemy);
      expect(JSON.stringify(fox.spec)).not.toMatch(/\bs dog\b/);
      expect(genre("Two knights duel the king's guard in a castle").enemy).toBe('guard');
      // Obrana („defends … from“) jde přes `namedFoe` – i ta musí vlastníka odtrhnout.
      expect(genre("A knight defends the castle from the king's guards").enemy).toBe('guard');
      expect(withoutPossessor("it's a race where the king's horse runs")).toBe("it's a race where the horse runs");
    });

    // B-R11: stažené „is“ po podstatném jménu není vlastník – „the game's over“ nesmí být „the over“.
    it('reads a contracted "is" after a noun instead of dropping the noun', () => {
      expect(withoutPossessor("the game's over when the dog's not looking")).toBe('the game is over when the dog is not looking');
      expect(withoutPossessor("the floor's lava and the farmer's dog chases you")).toBe('the floor is lava and the dog chases you');
      // Vlastník před věcí, která je náhodou nebezpečná plocha, se dál odtrhne.
      expect(withoutPossessor("the dragon's fire burns the knight")).toBe('the fire burns the knight');
    });

    it('prefers the place the look set knows', () => {
      expect(genre('Fly a paper plane through four hoops in the right order across a classroom.').setting).toBe('classroom');
    });
  });
});

/**
 * Mřížka archetypů po P32B T2 žije jen pro remix uložených legacy her
 * (`draftForControl(…, 'tap_go')`); testy níž, které čtou její archetyp,
 * počty a texty, proto jdou přes ni místo přes návrh nové hry.
 */
const grid = (sentence: string): GameSpecV1 => draftForControl(sentence, 'tap_go') as GameSpecV1;

describe('draftGameSpec', () => {
  it('yields a valid GameSpec for all forty sentences without ever falling back to the fixture', () => {
    for (const entry of corpus) {
      const meta = draftGameSpecWithMeta(entry.prompt, 1);
      expect(readGameSpec(meta.spec).ok, entry.id).toBe(true);
      expect(meta.fellBack, entry.id).toBe(false);
    }
  });

  it('hits the expected archetype on 32 of 32 corpus sentences and 8 of 8 pack bucket sentences (pin)', () => {
    const expected = corpus.filter((entry) => entry.expectArchetype !== null);
    const hits = expected.filter((entry) => grid(entry.prompt).archetype === entry.expectArchetype);
    expect(hits.length).toBe(32);
    const bucketHits = packBucketPrompts().filter((entry) => grid(entry.prompt).archetype === entry.expectArchetype);
    expect(bucketHits.length).toBe(8);
  });

  it('is byte-for-byte deterministic for the same seed and never throws on empty input', () => {
    for (const entry of corpus.slice(0, 5)) {
      expect(JSON.stringify(draftGameSpec(entry.prompt, 1))).toBe(JSON.stringify(draftGameSpec(entry.prompt, 1)));
    }
    expect(readGameSpec(draftGameSpec('')).ok).toBe(true);
    expect(readGameSpec(draftGameSpec('   ')).ok).toBe(true);
  });

  it('reads counts and seconds out of the sentence into the mechanics', () => {
    const mushrooms = grid('Collect five glowing mushrooms then open a portal');
    expect(mushrooms.mechanics.find((m) => m.id === 'collectible')?.params.count).toBe(5);
    expect(mushrooms.objective.count).toBe(5);
    expect(mushrooms.roles.find((r) => r.kind === 'collectible')?.label).toBe('glowing mushroom');

    const survive = grid('Survive 60 seconds while red floor tiles pulse dangerously.');
    expect(survive.mechanics.find((m) => m.id === 'timer')?.params.seconds).toBe(60);
    expect(survive.objective.seconds).toBe(60);

    const minutes = grid('Stay alive for two minutes in a haunted kitchen where the stove flares up.');
    expect(minutes.objective.seconds).toBe(120);
    // Žánr bere sekundy věty do mezí svého modulu (Aréna 20–80 s).
    expect(draftGameSpecWithMeta('Survive 60 seconds while red floor tiles pulse dangerously.').genre?.params).toEqual({ seconds: 60 });

    // Milion občanů se ořízne do mezí schématu, ne odmítne.
    const city = grid('Collect one million coins in the city.');
    expect(city.mechanics.find((m) => m.id === 'collectible')?.params.count).toBe(20);
  });

  it('collects what a hoarding hero hoards, not the place default', () => {
    // Věrnost j07 (P32B T6): bez slovesa „hoard“ sbírala veverka na louce květiny.
    const squirrel = draftGameSpec('a squirrel hoards acorns before winter comes');
    expect(squirrel.roles?.find((r) => r.kind === 'collectible')?.label).toBe('acorn');
  });

  it('puts the right article in front of the renamed role', () => {
    expect(grid('A lone knight gathers three iron keys inside a haunted castle.').tutorial.controlsHint).toMatch(/^Tap an iron key /);
    expect(grid('A knight must collect three keys in a haunted castle.').tutorial.controlsHint).toMatch(/^Tap a key /);
  });

  it('builds the title from content words, not filler', () => {
    expect(grid('jumping arcade game with a lot of obstacles').title).toBe('Jumping Arcade Obstacles');
    expect(grid('A knight must collect three keys in a haunted castle.').title).toBe('Knight Collect Three Keys');
  });

  // Hráč s větou o klíčích dostal „Tap a mushroom“ (QA 22. 9. 2026): text
  // ovládání zůstal z předlohy, i když se role přejmenovala.
  it('never leaves a template label in the texts after the sentence renamed that role', () => {
    let renamed = 0;
    for (const entry of corpus) {
      const meta = { spec: grid(entry.prompt), archetype: grid(entry.prompt).archetype };
      const template = JSON.parse(readFileSync(new URL(`../__fixtures__/${meta.archetype}.json`, import.meta.url), 'utf8')) as GameSpecV1;
      const texts = [meta.spec.tutorial.controlsHint, meta.spec.tutorial.goalLine, meta.spec.objective.description].join(' ').toLowerCase();
      for (const role of meta.spec.roles) {
        // Podstatné jméno předlohy („glowing mushroom“ → „mushroom“) – texty ho píšou samotné.
        const before = template.roles.find((r) => r.id === role.id)?.label.toLowerCase().split(' ').at(-1);
        if (before === undefined || role.label.toLowerCase().includes(before)) continue;
        renamed += 1;
        expect(texts, `${entry.id}: ${before} -> ${role.label}`).not.toMatch(new RegExp(`\\b${before}`));
      }
    }
    expect(renamed).toBeGreaterThan(10);
  });

  it('keeps the tutorial goal line under 80 characters and the labels under 60 for every sentence', () => {
    for (const entry of corpus) {
      const spec = draftGameSpec(entry.prompt);
      expect(spec.tutorial.goalLine.length).toBeLessThanOrEqual(80);
      for (const role of spec.roles) expect(role.label.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('lexicon', () => {
  it('names the pursuer, the carried item and its destination, and the switch colours', () => {
    expect(readRoles('A hamster escapes a supermarket while a giant Roomba hunts it.').chaser).toBe('giant roomba');
    const cake = readRoles('Carry a fragile cake across a kitchen to a party table.');
    expect(cake.item).toBe('fragile cake');
    expect(cake.destination).toBe('party table');
    expect(readRoles('Press red and blue but not green to open the door.').switches).toEqual({ all: ['red', 'blue', 'green'], required: ['red', 'blue'] });
    expect(readNumbers('Outlast a 45 second sandstorm with 3 lives')).toEqual({ seconds: 45, counts: [3] });
  });

  // P26 T9: hráč je podmět před prvním slovesem, jméno končí u slovesa v -ing.
  it.each([
    ['A penguin slides down an icy mountain collecting fish', 'penguin'],
    ['a squirrel jumping from tree to tree collecting acorns', 'squirrel'],
    ['A knight must collect three keys in a haunted castle', 'knight'],
    ['a slime that bounces higher every time it eats a candy', 'slime'],
    ['be a bee collecting pollen and bringing it to the hive', 'bee'],
    ['fly a paper plane through a house', 'paper plane'],
    ['a platformer where you jump between floating islands', null],
    // P26D T1: žánr za postavou se odřízne, žánr bez postavy postavou nezůstane.
    ['A corgi runner collecting bones', 'corgi'],
    ['a goat simulator', 'goat'],
    ['an endless runner in a neon city', null],
    ['a space shooter against asteroids', null],
    ['a runner game', null],
    ['A gold mine where I hire dwarves', null],
    ['tap to grow a garden that makes money while im away', null],
    ['The floor is lava, for 60 seconds', null],
  ])('reads the player of %j as %j', (sentence, player) => {
    expect(readRoles(sentence).player).toBe(player);
  });

  it('keeps verbs out of every label and setting over the 200-sentence demand corpus (pin: player in 40/200)', () => {
    const demand = JSON.parse(readFileSync('evals/play/demand/corpus.json', 'utf8')) as { readonly id: string; readonly text: string }[];
    const verbTail = /\b(?!(?:king|ring|thing|wing|string|building|ceiling|swing|sling|spring|pudding|viking|painting|clearing)\b)\w{2,}ing$/;
    const leaks: string[] = [];
    let players = 0;
    for (const { id, text } of demand) {
      if (readRoles(text).player !== null) players += 1;
      const spec = draftGameSpec(text);
      for (const label of [...spec.roles.map((role) => role.label), spec.theme.setting]) if (verbTail.test(label)) leaks.push(`${id}: ${label}`);
    }
    expect(leaks).toEqual([]);
    // Ve zbylých 160 větách postava není („shooting game“, „tower defense in space“).
    expect(players).toBeGreaterThanOrEqual(40);
  });
});
