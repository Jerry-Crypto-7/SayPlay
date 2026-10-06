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
import { toolsOf, withoutPossessor } from '../draft/lexicon';
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
    expect(wizard?.cast).toEqual(expect.arrayContaining([{ label: 'candle', does: 'reach', verb: 'light', states: 2 }, { label: 'ghost', does: 'chase_me' }]));
    const chef = draftGameSpecWithMeta('A chef cooks pancakes', 1, { modules: genreDoubles() }).genre;
    expect(chef?.cast).toContainEqual({ label: 'pancake', does: 'reach', verb: 'cook', states: 3 });
    expect(chef?.setting).toBe('kitchen');
    const knights = draftGameSpecWithMeta('Two knights duel in a castle', 1, { modules: genreDoubles() }).genre;
    expect(knights?.hero).toBe('knight');
    expect(knights?.cast).toContainEqual({ label: 'knight', does: 'fight' });
  });

  // Revize fáze 3, nález 2: „two knights“ je hrdina a jeden soupeř, ne rytíř proti dvěma. Od P36A T11 hraje souboj žánr Souboj.
  it('two knights duel one against one: the counted subject is not a count of rivals', () => {
    const duel = draftGameSpecWithMeta('Two knights duel in a castle', 1);
    expect(duel.genre).toMatchObject({ genre: 'duel', mode: 'default', hero: 'knight', cast: [{ label: 'knight', does: 'fight' }] });
    expect(duel.genre?.counts?.enemy).toBeUndefined();
    expect(duel.spec.roles.filter((role) => role.label === 'knight').map((role) => role.count ?? 1)).toEqual([1, 1]);
    // Číslovka před soupeřem, který není podmět, dál platí.
    expect(draftGameSpecWithMeta('A knight fights three wolves in a castle', 1).genre?.counts?.enemy).toBe(3);
  });

  // P41 drafts execute witnesses; keep the per-game timeout rather than putting
  // hundreds of simulations inside one 30-second test.
  it.each([...corpus.map((entry) => entry.prompt), ...demand.map((entry) => entry.text)])('drafts through a recipe without legacy fallback: %s', (sentence) => {
      const meta = draftGameSpecWithMeta(sentence, 1);
      expect(meta.fellBack, sentence).toBe(false);
      expect(meta.genre, sentence).not.toBeNull();
      if (meta.composition?.cellId.startsWith('drive.')) {
        expect(meta.spec.control, sentence).toBe('steer');
        expect(meta.spec.controlParams, sentence).not.toHaveProperty('generator');
        expect(meta.spec.genre, sentence).toBeUndefined();
      } else expect(meta.spec.genre?.id, sentence).toBe(meta.genre?.genre);
      expect(LEGACY_CONTROLS, sentence).not.toContain(meta.spec.control);
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
    const labels = (sentence: string) => (genre(sentence).cast ?? []).map((item) => item.label);
    /** Protivník obsazení: první položka, která hráče ohrožuje nebo se do ní střílí či bije. */
    const foe = (sentence: string) => genre(sentence).cast?.find((item) => ['shoot_at', 'chase_me', 'avoid', 'fight'].includes(item.does))?.label;

    it('never collects a pronoun', () => {
      expect(labels(sentenceSet.sentences.find((entry) => entry.id === 'wizard')!.text)).not.toContain('him');
      expect(labels('Escape the flooded subway before the security drone catches you.')).not.toContain('you');
    });

    // Od P36A T10 je „zombie shooter“ Střílečka: zombíci jdou ve vlnách jako nepřítel, terč střelnice je jiná role.
    it('does not make the enemy of a shooter its target too', () => {
      const zombie = genre('zombie shooter in a mall');
      expect(zombie).toMatchObject({ genre: 'shooter' });
      expect(zombie.cast?.filter((item) => item.label === 'zombie')).toEqual([{ label: 'zombie', does: 'shoot_at' }]);
    });

    it('does not set the game in a phrase that names one of its roles', () => {
      const log = genre('knife throwing at a spinning log');
      expect(log.cast).toContainEqual(expect.objectContaining({ label: 'spinning log', does: 'throw_at' }));
      expect(log.setting).not.toBe('spinning log');
    });

    // B-R1: „farmer's dog“ se dělením slov rozlomil na roli „s dog“ – v cíli i na liště cílů.
    it('keeps a possessive whole instead of making "s dog" a role', () => {
      const fox = draftGameSpecWithMeta("A fox steals eggs from a farm while the farmer's dog chases it", 1);
      expect(["farmer's dog", 'dog']).toContain(fox.genre!.cast?.find((item) => item.does === 'chase_me')?.label);
      expect(JSON.stringify(fox.spec)).not.toMatch(/\bs dog\b/);
      expect(foe("Two knights duel the king's guard in a castle")).toBe('guard');
      // Obrana („defends … from“) jde přes `namedFoe` – i ta musí vlastníka odtrhnout.
      expect(foe("A knight defends the castle from the king's guards")).toBe('guard');
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

  // P39 T5: každá věc, kterou věta jmenuje, je v obsazení s tím, co o ní říká sloveso – ve všech žánrech.
  describe('reads every named thing and what it does into the cast', () => {
    const cast = (sentence: string) => draftGameSpecWithMeta(sentence, 1).genre?.cast ?? [];

    it('shoots at what a shooting sentence is "against", typo or not, instead of a forest default', () => {
      for (const sentence of ['jumping and shooting game in the forest against animals', 'jumping and shooting game in the forest againts animals']) {
        expect(readRoles(sentence).named).toContainEqual({ label: 'animal', does: 'shoot_at' });
        const meta = draftGameSpecWithMeta(sentence, 1);
        expect(meta.genre?.genre).toBe('platformer');
        expect(meta.genre?.cast).toContainEqual({ label: 'animal', does: 'shoot_at' });
        // Les dá vlka jen tam, kde věta nikoho nejmenuje.
        expect(meta.genre?.cast?.map((item) => item.label)).not.toContain('wolf');
      }
    });

    it('keeps three named things with three different roles', () => {
      const sentence = 'collect coins, dodge ghosts and shoot bats';
      expect(readRoles(sentence).named).toEqual([
        { label: 'coin', does: 'collect' },
        { label: 'ghost', does: 'avoid' },
        { label: 'bat', does: 'shoot_at' },
      ]);
      expect(cast(sentence)).toEqual(expect.arrayContaining([{ label: 'coin', does: 'collect' }, { label: 'ghost', does: 'avoid' }, { label: 'bat', does: 'shoot_at' }]));
    });

    it('lets what chases the hero chase it in a runner too', () => {
      expect(cast('A dinosaur runs through a jungle, chased by a T-rex')).toContainEqual({ label: 't-rex', does: 'chase_me' });
    });

    it('reads targets in every genre, not only in fights, quests and throws', () => {
      const meta = draftGameSpecWithMeta('A frog hops across lily pads and shoots down the drones', 1);
      expect(['arena', 'quest', 'throw', 'duel']).not.toContain(meta.genre?.genre);
      expect(meta.genre?.cast).toContainEqual({ label: 'drone', does: 'shoot_at' });
    });

    // P39 T14: „shoot drones on a highway“ – za „on“ stojí místo, kde se střílí, ne cíl. Drony se četly jako nástroj
    // („shoots arrows at goblins“), z věty zmizely a střílelo se do aut z prostředí.
    it('shoots the drones named on a highway, not the cars of the place', () => {
      const meta = draftGameSpecWithMeta('run and shoot drones on a highway', 1);
      expect(meta.genre?.genre).toBe('runner');
      expect(meta.genre?.cast?.filter((item) => item.does === 'shoot_at')).toEqual([{ label: 'drone', does: 'shoot_at' }]);
      expect(toolsOf('run and shoot drones on a highway')).toEqual([]);
      // Za „on“ bez místa je to dál nástroj: voda letí na oheň.
      expect(toolsOf('shoot water on the fire')).toEqual(['water']);
    });

    it('never casts a place, the hero or one thing twice', () => {
      const escape = cast('Escape the flooded subway before the security drone catches you.');
      expect(escape.map((item) => item.label)).toEqual(['security drone']);
      expect(cast('A knight fights three wolves in a castle').filter((item) => item.label.includes('wolf'))).toEqual([{ label: 'wolf', does: 'fight' }]);
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

  it.each(demand)('keeps verbs out of every label and setting: $id', ({ id, text }) => {
    const verbTail = /\b(?!(?:king|ring|thing|wing|string|building|ceiling|swing|sling|spring|pudding|viking|painting|clearing)\b)\w{2,}ing$/;
    const leaks: string[] = [];
      const spec = draftGameSpec(text);
      for (const label of [...spec.roles.map((role) => role.label), spec.theme.setting]) if (verbTail.test(label)) leaks.push(`${id}: ${label}`);
    expect(leaks).toEqual([]);
  });
  it('still reads a player in at least 40 of the 200 demand sentences', () => {
    // Ve zbylých 160 větách postava není („shooting game“, „tower defense in space“).
    expect(demand.filter(({ text }) => readRoles(text).player !== null).length).toBeGreaterThanOrEqual(40);
  });
});
