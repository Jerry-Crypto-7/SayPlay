/**
 * Sklad uvařených světů.
 *
 * ⚠ **Oracle téhle sady je `runGeneration()`, ne tvar JSONu.** Sklad má jediný
 * smysl: vydat odpověď, se kterou serverová cesta dojede až do fáze `world`.
 * Test, který jen přečte soubor a spočítá klíče, by prošel i nad emisí, kterou
 * `compileBlueprint()` odmítne — a to je přesně případ, kvůli kterému sklad
 * existuje.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildIntentRequest } from '@/model/worldstream-intent';
import { buildCompilerRequest } from '@/model/worldstream-prompt';
import { frozenGrammar } from '@/model/client';

import {
  AUTHORED_STORE,
  authoredEmitter,
  chooseAuthored,
  distanceTo,
  EXACT_MAX_DISTANCE,
  HERO_WEIGHT,
  significantWords,
  type AuthoredWorld,
} from '../authored';
import { clearSessions, openSession, runGeneration, serverGrammar } from '../sessions';

const KNOWN = AUTHORED_STORE.worlds[0];
if (KNOWN === undefined) throw new Error('sklad je prázdný — sada nemá co měřit');

function grammar() {
  const read = frozenGrammar();
  if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
  return read.value;
}

beforeEach(() => {
  clearSessions();
});

/* ================================================================== *
 * 1. Celá cesta, protože jen ta odpovídá na otázku, k čemu sklad je.
 * ================================================================== */

describe('an authored world goes down the same path a live emission does', () => {
  it('drives a real session to the world phase', async () => {
    const emit = authoredEmitter(KNOWN.prompt);
    expect(emit).not.toBeNull();

    const stored = openSession('authored-happy', 4021)!;
    const seen: string[] = [];
    await runGeneration(stored, KNOWN.prompt, {
      emit: emit!,
      grammar: serverGrammar() as ReturnType<typeof grammar>,
      log: (fault, detail) => seen.push(`${fault}: ${detail}`),
    });

    expect(seen).toEqual([]);
    expect(stored.session.phase).toBe('world');
  });

  it('ends the session the way a broken live emission would, not silently', async () => {
    // Break-it-on-purpose: sklad, jehož compiler emise je próza. Kdyby ji sklad
    // pustil dál bez následku, demo by ukazovalo svět, který branami neprošel.
    const broken: AuthoredWorld = { ...KNOWN, compiler: { geometry: 'a cathedral, obviously' } };
    const emit = authoredEmitter(KNOWN.prompt, [broken]);

    const stored = openSession('authored-broken', 4021)!;
    const seen: string[] = [];
    await runGeneration(stored, KNOWN.prompt, {
      emit: emit!,
      grammar: serverGrammar() as ReturnType<typeof grammar>,
      log: (fault, detail) => seen.push(`${fault}: ${detail}`),
    });

    expect(stored.session.phase).toBe('failed');
    expect(seen[0]).toMatch(/^BLUEPRINT_REJECTED: /);
  });
});

/* ================================================================== *
 * 2. Kdy sklad říká „není z čeho".
 * ================================================================== */

describe('the store says when it has nothing', () => {
  it('is null on an empty store, not an emitter that answers with nothing', () => {
    // Prázdná emise by se tvářila jako odpověď modelu a relace by skončila
    // odmítnutím, které volajícímu nic neřekne. `null` je informace.
    expect(authoredEmitter(KNOWN.prompt, [])).toBeNull();
    expect(chooseAuthored(KNOWN.prompt, [])).toBeNull();
  });

  it('serves the nearest world for a sentence nobody authored, and says it is nearest', () => {
    // ⚠ **Tohle chování obrátila `T43` a je to rozhodnutí, ne oprava.** Do ní
    // vracel sklad `null` na neznámou větu, protože vydat cizí svět mlčky je
    // lež. Vydat ho **s popiskem** lež není, a prázdná obrazovka je horší než
    // nejbližší místo — porotce má právo zkoušet vlastní věty (`RULES.md` §3.3).
    const found = chooseAuthored('A lighthouse on a cliff above a storm-lit harbour');

    expect(found).not.toBeNull();
    expect(found?.match).toBe('nearest');
    expect(authoredEmitter('A lighthouse on a cliff above a storm-lit harbour')).not.toBeNull();
  });

  it('matches a sentence through punctuation and case, which a person will get wrong', () => {
    const found = chooseAuthored(`  ${KNOWN.prompt.toUpperCase().replace(/\.$/, '')}  `);

    expect(found?.world.id).toBe(KNOWN.id);
    expect(found?.match).toBe('exact');
  });
});

/* ================================================================== *
 * 3. Která emise na který požadavek — a NIKDY podle pořadí.
 * ================================================================== */

describe('the store answers the stage that asked, not the call that came first', () => {
  it('hands the planner answer to the planner request', async () => {
    const emit = authoredEmitter(KNOWN.prompt)!;
    const answer = (await emit(buildIntentRequest(KNOWN.prompt))) as Record<string, unknown>;

    expect(Object.keys(answer).sort()).toEqual(['intent', 'objects']);
  });

  it('hands the compiler answer to every compiler request, repair rounds included', async () => {
    // ⚠ **Tohle je celý důvod, proč se nerozlišuje podle pořadí.** Spike
    // z 5. 9. 2026 poslal na jednu větu čtyři požadavky: planner, compiler,
    // compiler, compiler. Pravidlo „druhé volání je compiler" by třetímu
    // a čtvrtému vydalo plán a smyčka by opravovala nesmysl.
    const emit = authoredEmitter(KNOWN.prompt)!;
    const plan = (await emit(buildIntentRequest(KNOWN.prompt))) as Parameters<
      typeof buildCompilerRequest
    >[0];
    const request = buildCompilerRequest(plan, grammar());

    for (let round = 0; round < 3; round += 1) {
      const answer = (await emit(request)) as Record<string, unknown>;
      expect(Object.keys(answer).sort()).toEqual(['geometry', 'placements', 'shapes', 'world']);
    }
  });

  it('refuses a request from neither stage instead of guessing', async () => {
    const emit = authoredEmitter(KNOWN.prompt)!;

    await expect(
      emit({ model: 'whatever', system: 'no stage claims this', user: '' }),
    ).rejects.toThrow(/does not recognise/);
  });
});

/* ================================================================== *
 * 4. Shoda: kdy sklad tvrdí „tuhle větu jsem uměl".
 * ================================================================== */

describe('the match is measured, not guessed', () => {
  it('gives every stored sentence its own world, and calls it exact', () => {
    // **Měří se nad celým skladem, ne nad vybranou větou.** Až `T44` doplní
    // zbylých 29 vět, roste tenhle test s ním a 30/30 z AC se ověří samo.
    // Kdyby byl napsaný na jedno `id`, mlčel by přesně tam, kde na tom záleží.
    const wrong = AUTHORED_STORE.worlds.filter((world) => {
      const found = chooseAuthored(world.prompt);
      return found?.world.id !== world.id || found.match !== 'exact';
    });

    expect(wrong.map((world) => world.id)).toEqual([]);
    expect(AUTHORED_STORE.worlds.length).toBeGreaterThan(0);
  });

  it('never calls a sentence from outside the corpus exact', () => {
    // ⚠ **Tohle je brána, na které stojí poctivost popisku z `T45`.** Kdyby
    // cizí věta dostala `exact`, produkt by tvrdil „tuhle větu jsem uměl" nad
    // světem, který patří někomu jinému — a porotce to odhalí druhou větou.
    const strangers = [
      'A lighthouse on a cliff above a storm-lit harbour',
      'A sunken ballroom lit by drifting jellyfish',
      'A desert observatory built from salvaged radio dishes',
      'A greenhouse growing inside a derelict aircraft',
      'A bell tower wrapped in frozen rope',
      'A market street folded into a single spiral staircase',
      'A quarry where the machines have become nests',
      'A monastery balanced on three basalt columns',
      'A launch gantry reclaimed by mangroves',
      'A skate park carved into a glacier',
      'A library whose shelves are the load-bearing walls',
      'A fishing village standing on the backs of stone whales',
      'A radio telescope filled with rainwater and reeds',
      'A cable car station suspended over an ash field',
      'A foundry where the furnaces have gone cold and green',
      'A hospital ward opening onto a cliff face',
      'A train yard rearranged into a single long house',
      'A windmill farm sunk to the hubs in drifting sand',
      'A courtroom at the bottom of a dry reservoir',
      'A bathhouse fed by a vent in the sea floor',
    ];

    const claimed = strangers.filter((prompt) => chooseAuthored(prompt)?.match === 'exact');

    expect(claimed).toEqual([]);
    // A přesto každá dostane svět — prázdná obrazovka není odpověď.
    for (const prompt of strangers) expect(chooseAuthored(prompt)).not.toBeNull();
  });

  it('is zero away from a sentence it holds and further from every other', () => {
    const world = AUTHORED_STORE.worlds[0]!;

    expect(distanceTo(world.prompt, world)).toBe(0);
    expect(distanceTo('a cable car station suspended over an ash field', world)).toBeGreaterThan(
      EXACT_MAX_DISTANCE,
    );
  });

  it('weighs a hero object heavier than an ordinary word, by exactly HERO_WEIGHT', () => {
    // ⚠ **Bez rozpadu `camelCase` by byl bonus mrtvý kód.** `heroObjects` drží
    // `stableId` jako `centralLightWell`; nerozpadlé se netrefí s ničím, co
    // člověk napíše, a váha by se nikdy neuplatnila.
    expect(significantWords('centralLightWell')).toEqual(['central', 'light', 'well']);

    // ⚠ **Číslo, ne nerovnost — a je to oprava po přeživší mutaci.** Původní
    // test jen tvrdil „hrdinský záznam je blíž než obyčejný", a to platí i když
    // se váha srazí na 1: trefené slovo se počítá tak jako tak. Mutant
    // `HERO_WEIGHT = 1` proto přežil. Pinuje se tedy hodnota, kterou váha
    // vyrábí: shoda 7 z 10 s trojkou proti 1 z 6 bez ní.
    const hero = { id: 'x', prompt: 'a wide hall of pale brick', heroObjects: ['stoneWhale'], synonyms: [], planner: {}, compiler: {} };
    const plain = { id: 'y', prompt: 'a wide hall of pale brick', heroObjects: [], synonyms: [], planner: {}, compiler: {} };

    expect(distanceTo('a hall with a stone whale', hero)).toBeCloseTo(0.3, 10);
    expect(distanceTo('a hall with a stone whale', plain)).toBeCloseTo(5 / 6, 10);
    expect(HERO_WEIGHT).toBe(3);
  });

  it('never lets a hero match push the distance below zero', () => {
    // První podoba vzorce hrdinská jména do jmenovatele nepočítala, takže shoda
    // mohla jmenovatel přerůst; výsledek se řezal u nuly a cizí věta, která
    // trefila dvě jména, dostala `exact`. Řez už ve vzorci není a nesmí být
    // potřeba.
    const world = { id: 'x', prompt: 'a hall', heroObjects: ['stoneWhale'], synonyms: ['whale'], planner: {}, compiler: {} };
    const found = chooseAuthored('a hall stone whale', [world]);

    expect(distanceTo('a hall stone whale', world)).toBe(0);
    expect(found?.match).toBe('exact');
    expect(distanceTo('stone whale', world)).toBeGreaterThan(0);
  });

  it('breaks a tie by id, not by where the world sits in the file', () => {
    // Pořadí v souboru se mění při každém doplnění skladu. Rozhodovat podle něj
    // znamená, že táž věta dostane po `T44` jiný svět než dneska.
    const twins = [
      { id: 'zz', prompt: 'a hall', heroObjects: [], synonyms: [], planner: {}, compiler: {} },
      { id: 'aa', prompt: 'a hall', heroObjects: [], synonyms: [], planner: {}, compiler: {} },
    ];

    expect(chooseAuthored('a hall', twins)?.world.id).toBe('aa');
    expect(chooseAuthored('a hall', [...twins].reverse())?.world.id).toBe('aa');
  });
});

describe('the nearest world is the nearest one, not the first one', () => {
  const shelf = [
    { id: 'a1', prompt: 'A lighthouse on a cliff above a storm-lit harbour', heroObjects: ['lighthouseTower'], synonyms: ['lighthouse'], planner: {}, compiler: {} },
    { id: 'a2', prompt: 'A sunken ballroom lit by drifting jellyfish', heroObjects: ['ballroomFloor'], synonyms: ['ballroom'], planner: {}, compiler: {} },
    { id: 'a3', prompt: 'A desert observatory built from salvaged radio dishes', heroObjects: ['radioDish'], synonyms: ['dish'], planner: {}, compiler: {} },
  ];

  it('picks the world the sentence is actually about', () => {
    // ⚠ **Tenhle test je jediný, který dnes chytne „vrať vždycky první".**
    // Sada nad skutečným skladem to zatím nechytne, protože sklad drží jednu
    // větu — dokud ho `T44` nenaplní, měří rozlišování jen tahle police.
    expect(chooseAuthored('a ballroom under water', shelf)?.world.id).toBe('a2');
    expect(chooseAuthored('a tower warning ships off the rocks', shelf)?.world.id).toBe('a1');
    expect(chooseAuthored('an observatory in the sand', shelf)?.world.id).toBe('a3');
  });

  it('does not let a short sentence sit close to everything', () => {
    // Kdyby se dělilo délkou dotazu místo sjednocením, byla by dvouslovná věta
    // blízko každému světu a „nejbližší" by ztratilo význam.
    const distances = shelf.map((world) => distanceTo('a ballroom', world));

    expect(Math.min(...distances)).toBeGreaterThan(EXACT_MAX_DISTANCE);
  });
});
