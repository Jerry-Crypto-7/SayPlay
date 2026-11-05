/**
 * Hrdina z věty podle identity, pak třídy (P32C T2). Jiný pták místo tučňáka
 * i auto místo pirátské lodi vypadají jako hra, jen ne ta z věty – okem to
 * projde, proto test drží úroveň výběru pro hrdiny a nepřátele devíti vět sady
 * `evals/play/p32/sentences.json`.
 *
 * `STATIC` je vstup pro T3: postavy, které se dnes hýbou jen procedurálně,
 * protože manifest pro ně nemá model s klipy. T4 ho po nových sadách zkrátí.
 */

import { describe, expect, it } from 'vitest';

import sentences from '../../../../evals/play/p32/sentences.json';
import type { GenreId } from '../../genre/contract';
import { heroChoice, riggedCharacter } from '../models';

/** Ovládání, na které žánr (a režim) hru překládá (`src/play/genre/*.ts`). */
const CONTROL: Readonly<Record<string, string>> = {
  runner: 'runner',
  'quest.spatial': 'move_free',
  'quest.station': 'move_free',
  'voyage.race': 'steer',
  'voyage.land': 'steer',
  'arena.escape': 'move_free',
  'arena.fight': 'duel',
};

const genreOf = (genre: string): GenreId => genre.split('.')[0] as GenreId;
const moves = (choice: ReturnType<typeof heroChoice>): boolean => choice.entry !== undefined && choice.entry.clips.run !== 'procedural';

/** Hrdina a nepřátelé devíti vět: model, úroveň výběru a jestli má model klipy (P32C T4: sady Kenney z T3). */
const EXPECTED: Readonly<Record<string, { readonly model: string; readonly clips: boolean }>> = {
  penguin: { model: 'rigged:pet-penguin', clips: true },
  'firefighter robot': { model: 'rigged:blocky-robot', clips: true },
  wizard: { model: 'rigged:mage', clips: true },
  // P71E T2c: generovaná loď byla z kamery voyage černá skvrna (tmavý trup, obrys lan); Kenney s bílými plachtami.
  'pirate ship': { model: 'cc0-ship-large', clips: false },
  cat: { model: 'rigged:pet-cat', clips: true },
  // P54B T4: kuchař je riggovaný kuchař Quaternius, ne číšník.
  chef: { model: 'rigged:q-chef', clips: true },
  dog: { model: 'rigged:pet-dog', clips: true },
  knight: { model: 'rigged:knight', clips: true },
  rocket: { model: 'rocket', clips: false },
};

/** Nepřátelé vět: duchové (čaroděj), lední medvěd (kočka), žralok (výchozí nepřítel moře). */
const FOES = ['ghost', 'polar bear', 'shark'];

/** Živé postavy bez klipů: jen ty z `evals/play/p32/kits-missing.md` (kuchaře doplnila P54B T4). Loď a raketa se hýbou procedurálně a stačí to. */
const STATIC = ['shark'];

describe('hero choice by identity, then class (P32C T2)', () => {
  it.each(sentences.sentences.map((sentence) => [sentence.hero, sentence.genre] as const))('%s (%s) is picked by identity', (hero, genre) => {
    const choice = heroChoice(hero, genreOf(genre), CONTROL[genre] as string);
    expect(choice.level, hero).toBe('identity');
    expect(choice.model).toBe(EXPECTED[hero]?.model);
    expect(moves(choice), `${hero} has clips`).toBe(EXPECTED[hero]?.clips);
  });

  it.each([
    ['ghost', 'rigged:graveyard-ghost'],
    ['polar bear', 'rigged:pet-polar-bear'],
    ['shark', 'cc0-shark'],
  ])('the foe %s is picked by identity', (label, model) => {
    expect(heroChoice(label, undefined, 'move_free', 'enemy')).toMatchObject({ level: 'identity', model });
  });

  it('records which heroes and foes still move only procedurally', () => {
    const heroes = sentences.sentences.map((sentence) => heroChoice(sentence.hero, genreOf(sentence.genre), CONTROL[sentence.genre] as string));
    const foes = FOES.map((label) => heroChoice(label, undefined, 'move_free', 'enemy'));
    const labels = [...sentences.sentences.map((sentence) => sentence.hero), ...FOES];
    const still = [...heroes, ...foes].flatMap((choice, index) => (moves(choice) || choice.entry?.class === 'boat' || choice.entry?.class === 'aircraft' ? [] : [labels[index]]));
    expect(still).toEqual(STATIC);
  });

  it('the pirate never rides a vehicle', () => {
    for (const genre of ['voyage', undefined] as const) {
      for (const label of ['pirate ship', 'pirate', 'a pirate ship full of pirates']) {
        const choice = heroChoice(label, genre, 'steer');
        expect(choice.entry?.class, `${label} / ${genre}`).not.toBe('vehicle');
        expect(choice.model, `${label} / ${genre}`).not.toBe('race-car');
      }
    }
    expect(heroChoice('pirate', undefined, 'steer')).toMatchObject({ model: 'cc0-ship-large', level: 'near' });
    expect(heroChoice('pirate', 'voyage', 'steer')).toMatchObject({ model: 'rigged:rogue', level: 'identity' });
  });

  it('reports near, class and fallback when the sentence names no model', () => {
    // Vlk má od P54B T3 vlastní riggovanou postavu Quaternius – dřív byl blízkou identitou psa (`WORD_MODEL`).
    expect(heroChoice('grey wolf', 'runner', 'runner')).toMatchObject({ model: 'rigged:q-wolf', level: 'identity' });
    // Hlava fráze před třídou: „lizard“ má třídu (liška), „wolf“ identitu – vyhraje vlk.
    expect(heroChoice('lizard wolf', 'runner', 'runner')).toMatchObject({ model: 'rigged:q-wolf', level: 'identity' });
    // P54B T4: zástupce kategorie a výchozí model role se kreslí riggovanou postavou (`RIGGED_ALIAS`).
    expect(heroChoice('wild badger', 'runner', 'runner')).toMatchObject({ model: 'rigged:q-fox', level: 'class' });
    // P37A T6: nejbližší model katalogu nad prahem je před třídou – sysel je křeček, ne liška
    // (ještěrka, dřív želva, má od P58A T7 vlastní model).
    expect(heroChoice('wild gopher', 'runner', 'runner')).toMatchObject({ model: 'hamster', level: 'near' });
    // Plavba zvíře připouští, stroj ne: vysokozdvižný vozík v závodě zůstane autem.
    expect(heroChoice('wild badger', 'voyage', 'steer')).toMatchObject({ model: 'rigged:q-fox', level: 'class' });
    expect(heroChoice('angry forklift', 'voyage', 'steer')).toMatchObject({ model: 'race-car', level: 'fallback' });
    expect(heroChoice('stapler', 'runner', 'runner')).toMatchObject({ model: 'rigged:q-cowboy-hair', level: 'fallback' });
    expect(heroChoice('stapler', undefined, 'flap')).toMatchObject({ model: 'gen3d-small-songbird', level: 'fallback' });
    expect(heroChoice('stapler', undefined, 'move_free', 'enemy')).toMatchObject({ model: 'rigged:blocky-robot', level: 'fallback' });
  });

  it('identity beats the genre, the genre bounds only near and class', () => {
    // Věc z věty (ponožka) je hrdina i v běžci; kategorie „stroj“ běžec pustí, plavba ne.
    expect(heroChoice('sock', 'runner', 'runner')).toMatchObject({ model: 'cc0-sock', level: 'identity' });
    expect(heroChoice('angry mech', 'runner', 'runner')).toMatchObject({ model: 'rigged:blocky-robot', level: 'class' });
    // Závod bez žánru bere jen vozidlo, loď nebo letadlo – i z manifestu, nejen dřívější seznam aut.
    expect(heroChoice('sailboat', undefined, 'steer')).toMatchObject({ model: 'gen3d-sailboat', level: 'identity' });
    // P70B T3: zvíře s klipy, které nic neveze, závodí samo („the rabbit races the turtle“); věc bez jízdy dál dostane auto.
    expect(heroChoice('dog', undefined, 'steer')).toMatchObject({ model: 'rigged:pet-dog', level: 'identity' });
    expect(heroChoice('stapler', undefined, 'steer')).toMatchObject({ model: 'race-car', level: 'fallback' });
    // V závodě tag katalogu před manifestem: tělo jádra `race-car` je na telefonu pod 4 % výšky.
    expect(heroChoice('race car', undefined, 'steer')).toMatchObject({ model: 'gen3d-race-car', level: 'identity' });
  });

  it('a rigged pick carries the manifest clips', () => {
    const knight = riggedCharacter(heroChoice('knight', 'arena', 'duel').model);
    expect(knight?.clips).toMatchObject({ idle: 'Idle', run: 'Running_A', jump: 'Jump_Idle', hit: 'Hit_A', die: 'Death_A' });
    // Kenney postavy klip zásahu nemají: manifest říká `procedural` a pohyb dopočítá RiggedModel.
    expect(riggedCharacter(heroChoice('brave little girl', 'runner', 'runner').model)?.clips.hit).toBe('procedural');
  });
});
