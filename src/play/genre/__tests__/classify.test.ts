/**
 * Klasifikátor žánru (P32B T1): věta → žánr a režim. Špatně zařazená věta dá
 * funkční, jen nesprávnou hru, a to by na snímku nikdo nepoznal – proto pin nad
 * pevnou sadou P32 (`evals/play/p32/sentences.json`) a nad draftovým korpusem.
 * Sada 9 vět běží od P32B T6 proti skutečným modulům; dvojníci (`./doubles`)
 * zůstali tam, kde test potřebuje režim `fallback`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../../evals/play/golden';
import sentenceSet from '../../../../evals/play/p32/sentences.json';
import { type CompareRow, loadSet, scoreOf } from '../../../../evals/play/p58b/compare.measure';
import { T13_MOVED } from '../../../../evals/play/p54c/rows';
import type { Reading } from '../../read/schema';
import { readGameSpec } from '../../spec';
import { classifyGenre, verbPlayedBy } from '../classify';
import { GENRES, GENRE_MODES, type GenreModule, type GenreSpec } from '../contract';
import { GENRE_MODULES } from '../index';

import { genreDoubles } from './doubles';

const demand = JSON.parse(readFileSync(new URL('../../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as { readonly text: string }[];

// Střílečka a hod jsou od P36A T10 zase žánry, poletování, načasování, rytmus a souboj od T11; žánr nemá jen `tap_go`.
const LEGACY_CONTROLS = ['tap_go'];
/** P58B T5: jistá čtení astry, která sama trefila (117 cílů + 26 pastí ze 160 vět) – hlídá, že pin data opravdu prošel. */
const SCORED_READINGS = 143;

const top = (sentence: string, modules = genreDoubles()) => classifyGenre(sentence, null, modules).ranked[0];

describe('verbPlayedBy', () => {
  it('reads the mode, not only the genre: a fight is played by arena.fight, not arena.escape', () => {
    expect(verbPlayedBy(['fight'], 'arena', 'fight', false)).toBe(true);
    expect(verbPlayedBy(['fight'], 'arena', 'escape', false)).toBe(false);
    expect(verbPlayedBy(['escape'], 'arena', 'escape', false)).toBe(true);
  });

  it('a base form with several rows is played by each of them: defend is the arena fight and the lane defense (P54C T13)', () => {
    expect(verbPlayedBy(['defend'], 'arena', 'fight', false)).toBe(true);
    expect(verbPlayedBy(['defend'], 'defense', 'default', false)).toBe(true);
    expect(verbPlayedBy(['defend'], 'arena', 'escape', false)).toBe(false);
  });
});

describe('classifyGenre', () => {
  it.each(sentenceSet.sentences)('puts the expected genre and mode first for $id', (entry) => {
    const [genre, mode] = entry.genre.split('.');
    const result = classifyGenre(entry.text, null, GENRE_MODULES);
    expect(result.ranked[0].genre).toBe(genre);
    if (mode !== undefined) expect(result.ranked[0].mode).toBe(mode);
    expect(result.ranked[0].score).toBeGreaterThan(0);
    expect(result.verb).toBe(entry.verb);
    expect(result.fallback).toBe(false);
  });

  it('never puts a fallback mode first while a ready mode scored', () => {
    // Úkol hraje náhradu: čaroděj dostane hratelný ready žánr, ne pahýl.
    const wizard = classifyGenre('A tiny wizard rides a broom through a haunted castle and must light five candles before the ghosts catch him', null, genreDoubles(['quest.spatial', 'quest.station']));
    expect(wizard.ranked[0].genre).not.toBe('quest');
    expect(wizard.fallback).toBe(false);
    // Úkol pořád slyšel nejvíc – oprava ho zkusí, jen ne jako první.
    expect(wizard.ranked.findIndex((choice) => choice.genre === 'quest')).toBeGreaterThan(0);
  });

  it('puts a fallback mode first only when nothing else scored, and says so', () => {
    const chef = classifyGenre('A chef cooks pancakes', null, genreDoubles(['quest.spatial', 'quest.station']));
    expect(chef.ranked[0]).toMatchObject({ genre: 'quest', mode: 'station' });
    expect(chef.fallback).toBe(true);
    const rocket = classifyGenre('A rocket lands on Mars', null, genreDoubles(['voyage.land']));
    expect(rocket.ranked[0]).toMatchObject({ genre: 'voyage', mode: 'race' });
    expect(rocket.fallback).toBe(false);
  });

  // B-R3: sada 9 vět necvičí každý řádek tabulky sloves – bez těchhle vět šlo řádek odebrat a nic nezčervenalo.
  it.each([
    ['A frog jumps over logs', 'platformer.default', 'jump'],
    ['A goat climbs a mountain', 'platformer.default', 'climb'],
    ['Two robots fight in an arena', 'arena.fight', 'fight'],
    ['boxing a kangaroo in the australian outback', 'arena.fight', 'box'],
    ['A mouse collects cheese in a kitchen', 'arena.collect', 'collect'],
    ['A bird flies over the city', 'voyage.race', 'fly'],
    ['A girl drives a car through the desert', 'voyage.race', 'drive'],
    ['A boy rides a bike to school', 'voyage.race', 'ride'],
    ['A bear skis down a mountain', 'runner.default', 'ski'],
    ['A robot repairs a broken engine', 'quest.station', 'repair'],
    ['A knight frees the prisoners in a tower', 'quest.spatial', 'free'],
    ['A chef flips burgers', 'quest.station', 'cook'],
    ['A space marine shoots alien bugs in a mining colony', 'shooter.default', 'shoot'],
    ['shoot the ghosts in a haunted carnival shooting gallery', 'shooter.default', 'shoot'],
    ['throwing snowballs at kids behind a snow fort', 'throw.default', 'throw'],
    ['bowling in a haunted alley', 'throw.default', 'throw'],
    ['satisfying game where you pop stuff', 'quest.spatial', 'hit'],
    // P36A T11: načasování, rytmus, souboj a poletování.
    ['stack blocks as high as u can', 'timing.stack', 'stack'],
    ['build the tallest pancake tower before it falls over', 'timing.stack', 'stack'],
    ['tap at the right time to stop the moving platform', 'timing.precision', 'time'],
    ['hold to grow a bridge and let go to cross the gap', 'timing.bridge', 'bridge'],
    ['a dance battle in a disco', 'rhythm.default', 'dance'],
    ['tap to the beat with glowing tiles', 'rhythm.default', 'beat'],
    ['A pirate duels a skeleton captain on a sinking ship', 'duel.default', 'duel'],
    ['A little bird flaps through the pipes', 'flap.default', 'flap'],
    // Rvačka a box s víc soupeři zůstávají Arénou, hod nožem a placky hodem (třída slovesa v poptávce je načasování).
    ['A grandma karate fights a gang of pigeons in the park', 'arena.fight', 'fight'],
    ['knife throwing at a spinning log', 'throw.default', 'throw'],
    ['toss a pancake and catch it on the pan', 'throw.default', 'throw'],
  ])('plays "%s" as %s with the verb %s', (sentence, mode, verb) => {
    const result = classifyGenre(sentence, null, GENRE_MODULES);
    expect(`${result.ranked[0].genre}.${result.ranked[0].mode}`).toBe(mode);
    expect(result.verb).toBe(verb);
  });

  it('ranks every mode of every genre once and gives a sentence with no cue the arena collect, the runner last', () => {
    const result = classifyGenre('A key inside a glass box on a pedestal behind a locked gate.', null, genreDoubles());
    // Kostry P54C (T4, `staged`) v pořadí nejsou vůbec.
    const doubles = genreDoubles();
    const modes = GENRES.flatMap((genre) => GENRE_MODES[genre].filter((mode) => doubles[genre].availability(mode as never) !== 'staged')).length;
    expect(result.ranked).toHaveLength(modes);
    expect(new Set(result.ranked.map((choice) => `${choice.genre}.${choice.mode}`)).size).toBe(modes);
    expect(result.ranked[0]).toMatchObject({ genre: 'arena', mode: 'collect', score: 0 });
    expect(result.ranked.at(-1)).toMatchObject({ genre: 'runner', mode: 'default', score: 0 });
    expect(result.verb).toBeNull();
  });

  // P36A T11: věta bez slovesa z tabulky – rozhodne jméno nebo téma, ne pořadí žánrů.
  it.each([
    ['piano tiles but falling from space', 'rhythm.default'],
    ['a song about the sea with drums and lights', 'rhythm.default'],
    ['my rival from school at high noon', 'duel.default'],
    ['like flappy bird but underwater', 'flap.default'],
    // Přejít rušnou silnici je od P54C T13b sloveso přeskákání (P30 d05, `T13_MOVED`); jméno běhu dál rozhodne jinde.
    ['a sloth tries to cross a frozen lake', 'runner.default'],
  ])('plays the verbless "%s" as %s', (sentence, mode) => {
    const first = classifyGenre(sentence, null, GENRE_MODULES).ranked[0];
    expect(`${first.genre}.${first.mode}`).toBe(mode);
    expect(first.score).toBeGreaterThan(0);
  });

  it('lets the reading add its main verb and chaser', () => {
    const reading: Reading = {
      control: 'move_free',
      verbs: [{ word: 'wander', class: 'move_free' }],
      hero: 'fox',
      roles: [{ noun: 'wolf', kind: 'chaser', count: 1 }],
      setting: 'forest',
      mood: null,
      numbers: { seconds: null, counts: [] },
      genre: null,
      sure: true,
      foe: null,
      item: null,
      world: null,
      title: null,
    };
    const result = classifyGenre('A fox in a forest', reading, genreDoubles());
    expect(result.ranked[0]).toMatchObject({ genre: 'arena', mode: 'escape' });
    expect(result.ranked[0].why).toContain('reading');
  });

  // P58B T5 (dřív P56A T5, kde slovník rozhodl, kdykoli první slyšel nový žánr P54C): platné čtení rozhoduje žánr i režim,
  // i proti dobře slyšenému slovesu nového žánru. Slovník rozhodne jen když si čtení není jisté (`sure: false`) a něco
  // slyšel. Režim, který nehraje (`fallback`), čtení nerozhodne.
  describe('a sure reading genre decides; the keywords only when the reading is unsure (P58B T5)', () => {
    const read = (genre: Reading['genre'], sure = true): Reading => ({
      control: 'move_free', verbs: [], hero: null, roles: [], setting: null, mood: null,
      numbers: { seconds: null, counts: [] }, genre, sure, foe: null, item: null, world: null, title: null,
    });
    const order = (sentence: string, reading: Reading | null, modules: Parameters<typeof classifyGenre>[2] = genreDoubles()) => classifyGenre(sentence, reading, modules).ranked.map((choice) => `${choice.genre}.${choice.mode}`);
    const CATCH = 'a bear catches falling honey jars in a basket';
    const running = (sure: boolean): Reading => ({ ...read({ genre: 'runner', mode: 'default' }, sure), verbs: [{ word: 'run', class: 'runner' }, { word: 'dash', class: 'runner' }, { word: 'sprint', class: 'runner' }] });

    it('goes first over a heard old-genre verb and leaves the rest in keyword order', () => {
      const sentence = 'Two knights duel in a castle';
      const ranked = classifyGenre(sentence, read({ genre: 'arena', mode: 'collect' }), genreDoubles()).ranked;
      expect(ranked[0]).toMatchObject({ genre: 'arena', mode: 'collect' });
      expect(ranked[0].score).toBeGreaterThan(0);
      expect(ranked[0].why).toContain('reading genre');
      expect(ranked.slice(1).map((choice) => `${choice.genre}.${choice.mode}`)).toEqual(order(sentence, null).filter((id) => id !== 'arena.collect'));
    });

    it('goes first over a heard new genre too', () => {
      expect(order(CATCH, null, GENRE_MODULES)[0]).toBe('catch.default');
      const ranked = classifyGenre(CATCH, running(true), GENRE_MODULES).ranked;
      expect(ranked[0]).toMatchObject({ genre: 'runner', mode: 'default' });
      expect(ranked[0].why).toContain('reading genre');
    });

    it('yields to what the keywords heard when it is unsure, also against its own verbs', () => {
      expect(order(CATCH, running(false), GENRE_MODULES)[0]).toBe('catch.default');
      expect(order('Two knights duel in a castle', read({ genre: 'arena', mode: 'collect' }, false))[0]).toBe('duel.default');
    });

    it('still decides when it is unsure and the keywords heard nothing', () => {
      const sentence = 'A key inside a glass box on a pedestal behind a locked gate.';
      expect(classifyGenre(sentence, null, genreDoubles()).ranked[0].score).toBe(0);
      expect(order(sentence, read({ genre: 'duel', mode: 'default' }, false))[0]).toBe('duel.default');
    });

    it('decides like a sure one when it was stored before the sure field', () => {
      const { sure: _drop, ...stored } = running(true);
      expect(order(CATCH, stored as Reading, GENRE_MODULES)[0]).toBe('runner.default');
    });

    it('reads a new genre the keywords do not hear', () => {
      expect(order('Two knights duel in a castle', read({ genre: 'catch', mode: 'default' }), GENRE_MODULES)[0]).toBe('catch.default');
    });

    it('does not decide a mode that plays a stand-in', () => {
      expect(order('Two knights duel in a castle', read({ genre: 'quest', mode: 'station' }), genreDoubles(['quest.station']))[0]).toBe('duel.default');
    });

    // P58B T6: „žádný žánr nesedí“ (p56a s68 „rock band“ → rytmus, s74 „race“ → plavba, s80 „shoot pics“ → střílečka).
    it('a null genre plays the arena collect over the heard keyword, the rest in keyword order', () => {
      const sentence = 'Two knights duel in a castle';
      const ranked = classifyGenre(sentence, read(null), genreDoubles()).ranked;
      expect(ranked[0]).toMatchObject({ genre: 'arena', mode: 'collect' });
      expect(ranked[0].why).toContain('no genre fits');
      expect(ranked.slice(1).map((choice) => `${choice.genre}.${choice.mode}`)).toEqual(order(sentence, null).filter((id) => id !== 'arena.collect'));
    });

    it('a null genre flees only a chaser the reading names, not the word escape', () => {
      const sentence = 'an escape room in a haunted mansion full of riddles';
      expect(order(sentence, null, GENRE_MODULES)[0]).toBe('arena.escape');
      expect(order(sentence, read(null), GENRE_MODULES)[0]).toBe('arena.collect');
      const chased = { ...read(null), roles: [{ noun: 'ghost', kind: 'chaser' as const, count: null }] };
      expect(order(sentence, chased, GENRE_MODULES)[0]).toBe('arena.escape');
    });

    it('a reading stored without the genre field leaves the keyword order', () => {
      const { genre: _drop, ...stored } = read(null);
      expect(order('Two knights duel in a castle', stored as Reading)).toEqual(order('Two knights duel in a castle', null));
    });
  });

  // P58B T5: na datech – čtení astry s polem `sure` (`evals/play/p58b/compare-dev-t5.json`, dev sady p56a a p55). Jisté
  // čtení, které samo trefilo, slovník nepřebije (v T3 přebil p56a s02 a p55 h78), a žádný žánr cílů neklesne proti T3
  // (`compare-dev.json`) o víc než 1 větu – nejisté čtení p56a s39 tak úkol stálo 4 → 3.
  it('lets the keywords beat no sure reading that scored on its own and drops no genre by more than 1 target against T3', () => {
    const rows = (file: string) => (JSON.parse(readFileSync(new URL(`../../../../evals/play/p58b/${file}`, import.meta.url), 'utf8')) as { rows: CompareRow[] }).rows;
    const sets = new Map(['p56a/holdout', 'p55/holdout'].map((name) => [name, new Map(loadSet(`evals/play/${name}.json`).sentences.map((row) => [row.id, row]))]));
    const before = new Map(rows('compare-dev.json').map((row) => [`${row.set} ${row.id}`, row.models['astra@openai']!.hit]));
    const beaten: string[] = [];
    const genres: Record<string, { before: number; now: number }> = {};
    let scored = 0;
    for (const row of rows('compare-dev-t5.json')) {
      const sentence = sets.get(row.set)?.get(row.id);
      const read = row.models['astra@openai']!;
      if (sentence === undefined || read.reading === null) continue;
      const first = classifyGenre(sentence.text, read.reading, GENRE_MODULES).ranked[0];
      const hit = scoreOf(sentence, `${first.genre}.${first.mode}`).hit === true;
      if (row.kind === 'target') {
        const genre = (genres[row.label!.split('.')[0]!] ??= { before: 0, now: 0 });
        genre.before += before.get(`${row.set} ${row.id}`) === true ? 1 : 0;
        genre.now += hit ? 1 : 0;
      }
      if (read.reading.sure === false || scoreOf(sentence, read.readGenre).hit !== true) continue;
      scored += 1;
      if (!hit) beaten.push(`${row.set} ${row.id}: read ${read.readGenre}, played ${first.genre}.${first.mode}`);
    }
    expect(beaten).toEqual([]);
    expect(Object.entries(genres).filter(([, count]) => count.now < count.before - 1)).toEqual([]);
    expect(scored).toBe(SCORED_READINGS);
  });

  // P58B T6: čtení astry s promptem kola 2 (`compare-dev-t6b.json`, dev p56a + p55) dnešním `classifyGenre` – brána plánu
  // 48/60 cílů a 18/20 pastí přepočtená na 120 cílů a 40 pastí dev.
  it('plays the T6 readings of dev at the gate: targets ≥ 96/120, traps ≥ 36/40', () => {
    const { rows } = JSON.parse(readFileSync(new URL('../../../../evals/play/p58b/compare-dev-t6b.json', import.meta.url), 'utf8')) as { rows: CompareRow[] };
    const sets = new Map(['p56a/holdout', 'p55/holdout'].map((name) => [name, new Map(loadSet(`evals/play/${name}.json`).sentences.map((row) => [row.id, row]))]));
    const count = { target: { of: 0, hit: 0 }, trap: { of: 0, hit: 0 } };
    for (const row of rows) {
      const sentence = sets.get(row.set)!.get(row.id)!;
      const reading = row.models['astra@openai']!.reading;
      const kind = count[row.kind as 'target' | 'trap'];
      kind.of += 1;
      // Chybějící čtení je minutá věta jako v měřidle, ne body slovníku.
      if (reading === null) continue;
      const first = classifyGenre(sentence.text, reading, GENRE_MODULES).ranked[0];
      kind.hit += scoreOf(sentence, `${first.genre}.${first.mode}`).hit === true ? 1 : 0;
    }
    expect(count.target.of).toBe(120);
    expect(count.trap.of).toBe(40);
    expect(count.target.hit).toBeGreaterThanOrEqual(96);
    expect(count.trap.hit).toBeGreaterThanOrEqual(36);
  });

  // P56A final.md: s02, s03, s09 a s12 – gpt-oss-20b přečetl správně a pravidlo P56A T5 ho přebilo slovem slovníku.
  it.each(['s02', 's03', 's09', 's12'])('plays the right gpt-oss-20b reading of P56A %s that the keywords used to beat', (id) => {
    const json = <T,>(path: string) => JSON.parse(readFileSync(new URL(`../../../../evals/play/p56a/${path}`, import.meta.url), 'utf8')) as T;
    const sentence = json<{ sentences: { id: string; genre: string; text: string }[] }>('holdout.json').sentences.find((row) => row.id === id)!;
    const reading = json<{ readings: { id: string; reading: Reading }[] }>('readings/holdout.gpt-oss-20b.json').readings.find((row) => row.id === id)!.reading;
    expect(`${reading.genre?.genre}.${reading.genre?.mode}`).toBe(sentence.genre);
    const first = classifyGenre(sentence.text, reading, GENRE_MODULES).ranked[0];
    expect(`${first.genre}.${first.mode}`).toBe(sentence.genre);
  });

  // P39 T5: hlavní sloveso říká, co jeho předmět ve hře dělá; pohyb a načasování předmět obsazení nemají.
  it('says what the main verb does to its object', () => {
    const does = (sentence: string) => classifyGenre(sentence, null, GENRE_MODULES).does;
    expect(does('shoot the aliens in space')).toBe('shoot_at');
    expect(does('throw balls at rubber ducks')).toBe('throw_at');
    expect(does('A knight fights three wolves')).toBe('fight');
    expect(does('A tiny wizard must light five candles in a haunted castle')).toBe('reach');
    expect(does('a cat collects fish in a kitchen')).toBe('collect');
    expect(does('run through a city')).toBeNull();
  });

  it('explains the pick in words the reading panel can show', () => {
    expect(top('Two knights duel in a castle').why).toMatch(/duel/);
  });

  // P32B T5b: karta nápadu „The floor is lava“ je hra na přežití, ne běžec přes lávu (narážka `lava`).
  it('reads "the floor is lava" as a survival escape', () => {
    expect(top('The floor is lava, for 60 seconds', GENRE_MODULES)).toMatchObject({ genre: 'arena', mode: 'escape' });
  });

  // P54C T13: klasifikátor, který by do nových žánrů přetáhl staré věty, dá zelené testy a jiné hry – pin nad P30 dev
  // proti startu P54C (`start.json`) a nad dev sadou P54C (živé žánry hrají svůj žánr, pasti zůstanou, kde byly v T2).
  it('moves no P30 dev sentence off its P54C starting genre except the three defense sentences (T13), the road crossing and the sumo ring (T13b)', () => {
    const json = (path: string) => JSON.parse(readFileSync(new URL(`../../../../evals/play/${path}`, import.meta.url), 'utf8')) as { sentences: { id: string; text: string; classify: string }[] };
    const was = new Map(json('p54c/start.json').sentences.map((row) => [row.id, row.classify]));
    const moved = Object.fromEntries(json('p30/dev.json').sentences.flatMap(({ id, text }) => {
      const first = classifyGenre(text, null, GENRE_MODULES).ranked[0];
      const now = `${first.genre}.${first.mode}`;
      return now === was.get(id) ? [] : [[id, now]];
    }));
    expect(moved).toEqual(Object.fromEntries(Object.entries(T13_MOVED).map(([id, row]) => [id, row.classify])));
  });

  it('puts every P54C dev sentence of a routed genre in its genre and leaves the traps where T2 found them', () => {
    const json = (path: string) => JSON.parse(readFileSync(new URL(`../../../../evals/play/p54c/${path}`, import.meta.url), 'utf8')) as { sentences: { id: string; family: string; expect: string; text: string; classify: string }[] };
    const baseline = new Map(json('baseline.json').sentences.map((row) => [row.id, row.classify]));
    // Žánry MVP, které klasifikátor zná od T13, a žánry fáze 3 od T13b (přeskákání, dav, slučování, vytlačování).
    const routed = new Set(['catch.default', 'whack.default', 'defense.default', 'slice.default', 'hop.default', 'crowd.default', 'merge.default', 'push.default']);
    const sentences = json('dev.json').sentences;
    for (const row of sentences) {
      const first = classifyGenre(row.text, null, GENRE_MODULES).ranked[0];
      const now = `${first.genre}.${first.mode}`;
      if (row.family === 'trap') expect(now, row.id).toBe(baseline.get(row.id));
      else if (routed.has(row.expect)) expect(now, row.id).toBe(row.expect);
      else expect(routed.has(now), row.id).toBe(false);
    }
    expect(sentences.filter((row) => routed.has(row.expect))).toHaveLength(64);
  });

  // P55 T3: holdout P54C otevřený v T16 je od té doby vývojová data – opisy nezávislého autora, na kterých klasifikátor
  // padal. Pin drží každý pruhový žánr na ≥ 6/8, žádnou větu, kterou P55 výchozí stav trefil, a rušivé věty mimo nové žánry.
  it('reads the paraphrases of the opened P54C holdout: each lane genre ≥ 6/8, no earlier hit lost, distractors stay out (P55 T3)', () => {
    const json = (path: string) => JSON.parse(readFileSync(new URL(`../../../../evals/play/${path}`, import.meta.url), 'utf8')) as { sentences: { id: string; family: string; genre: string | null; text: string }[] };
    const baseline = JSON.parse(readFileSync(new URL('../../../../evals/play/p55/baseline.json', import.meta.url), 'utf8')) as { sets: { p54cHoldoutOpened: { rows: { id: string; expect: string | null; classify: string }[] } } };
    const hitBefore = new Set(baseline.sets.p54cHoldoutOpened.rows.filter((row) => row.expect === row.classify).map((row) => row.id));
    const fresh = new Set(['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push']);
    const hits: Record<string, number> = {};
    const lost: string[] = [];
    const strayed: string[] = [];
    for (const row of json('p54c/holdout.json').sentences) {
      const first = classifyGenre(row.text, null, GENRE_MODULES).ranked[0];
      if (row.family === 'distractor') {
        if (fresh.has(first.genre)) strayed.push(`${row.id}: ${first.genre}`);
        continue;
      }
      if (first.genre === row.genre) hits[row.genre!] = (hits[row.genre!] ?? 0) + 1;
      else if (hitBefore.has(row.id)) lost.push(`${row.id}: ${first.genre}.${first.mode}`);
    }
    for (const genre of ['catch', 'whack', 'defense', 'slice']) expect(hits[genre] ?? 0, genre).toBeGreaterThanOrEqual(6);
    // T4: každý žánr fáze 3 (7 vět) aspoň 6 a celkem ≥ 52/60 – rezerva proti přeučení na zapečetěné sadě P55.
    for (const genre of ['hop', 'crowd', 'merge', 'push']) expect(hits[genre] ?? 0, genre).toBeGreaterThanOrEqual(6);
    expect(Object.values(hits).reduce((sum, hit) => sum + hit, 0)).toBeGreaterThanOrEqual(52);
    expect(lost).toEqual([]);
    expect(strayed).toEqual([]);
  });

  // P56A T5: zlatý test – bez čtení je celé pořadí u každé věty tří dev sad totéž jako ve výchozích číslech P56A (T1).
  it('keeps the whole keyword order of every dev sentence without a reading (P56A baseline)', () => {
    const baseline = JSON.parse(readFileSync(new URL('../../../../evals/play/p56a/baseline.json', import.meta.url), 'utf8')) as { sets: Record<string, { rows: { id: string; ranked: string }[] }> };
    const sets = { p30Dev: 'p30/dev.json', p54cDev: 'p54c/dev.json', p55HoldoutOpened: 'p55/holdout.json' };
    for (const [name, path] of Object.entries(sets)) {
      const was = new Map(baseline.sets[name]!.rows.map((row) => [row.id, row.ranked]));
      const sentences = (JSON.parse(readFileSync(new URL(`../../../../evals/play/${path}`, import.meta.url), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
      expect(sentences).toHaveLength(was.size);
      for (const { id, text } of sentences) expect(classifyGenre(text, null, GENRE_MODULES).ranked.map((choice) => `${choice.genre}.${choice.mode}`).join(' '), `${name} ${id}`).toBe(was.get(id));
    }
  });

  it('never throws on the draft corpora and never lands a new game on a legacy control', () => {
    const sentences = [...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text), '', '   '];
    for (const sentence of sentences) {
      for (const modules of [genreDoubles(), GENRE_MODULES]) {
        const first = classifyGenre(sentence, null, modules).ranked[0];
        const spec = { genre: first.genre, mode: first.mode, hero: 'fox', setting: 'forest' } as GenreSpec;
        const game = (modules[first.genre] as GenreModule).compile(spec as never);
        expect(readGameSpec(game).ok, sentence).toBe(true);
        expect(LEGACY_CONTROLS, sentence).not.toContain(game.control);
      }
    }
  });
});
