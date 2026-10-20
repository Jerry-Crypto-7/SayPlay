import { loadRapier } from '@/play/arcade/physics/world';
/**
 * Co AI verze přidá a co nesmí rozbít (P32B T7, z náhledu O10). Všechno by
 * vypadalo dobře a bylo špatně: „without hitting a rocks“ je jen o písmeno
 * delší, hasič, kterého honí jeho vlastní voda, hru dohraje, a AI verze, která
 * opíše rychlou, projde každou kontrolou. Model se nevolá – odpovědi jsou zmrazené.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../evals/play/golden';
import sentenceSet from '../../../evals/play/p32/sentences.json';
import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { buildCompactRequest } from '../director/compact';
import { fidelity } from '../director/critic';
import { direct } from '../director/index';
import { buildDirectorRequest } from '../director/prompt';
import { readGenreAnswer } from '../director/read';
import { draftGameSpec, draftGameSpecWithMeta } from '../draft';
import { readRoles, singular, toolsOf } from '../draft/lexicon';
import type { GenreSpec } from '../genre/contract';
import { isAmmo } from '../genre/throw';
import { actionEvidence, missingActions } from '../fidelity/action-evidence';
import { extractIntent } from '../intent/extract';

const sentence = (id: string): string => sentenceSet.sentences.find((entry) => entry.id === id)!.text;
const draftOf = (text: string) => {
  const meta = draftGameSpecWithMeta(text);
  if (meta.genre === null || meta.genre === undefined) throw new Error(`no genre for ${text}`);
  return { genre: meta.genre, spec: meta.spec };
};
const answer = (spec: GenreSpec) => ({ plan: 'frozen', spec });
const directed = (text: string, spec: GenreSpec) => direct(text, { branch: fakeBranch([answered(answer(spec))]), now: () => 0 });

describe('the director answer, read like the quick version', () => {
  it('turns plural role labels singular, so the goal line matches the quick version', () => {
    const penguin = draftOf(sentence('penguin'));
    const chef = draftOf(sentence('chef'));
    const plural = [
      { quick: penguin.spec, written: { ...penguin.genre, cast: [{ label: 'rocks', does: 'avoid' as const }, { label: 'snowflakes', does: 'collect' as const }] } },
      { quick: chef.spec, written: { ...chef.genre, cast: chef.genre.cast!.map((item) => (item.does === 'reach' ? { ...item, label: 'pancakes' } : item)) } },
    ];
    for (const { quick, written } of plural) {
      const read = readGenreAnswer(answer(written));
      if (!read.ok) throw new Error(read.detail);
      expect(read.spec.objective.description).toBe(quick.objective.description);
    }
    expect(penguin.spec.objective.description).toContain('a rock.');
    expect(chef.spec.objective.description).toContain('all 2 pancakes in');
  });

  it('keeps -us words, names and irregular plurals whole when it makes a label singular', () => {
    expect(['wolves', 'knives', 'mice', 'octopus', 'bus', 'Thomas', 'glowing fish', 'burning trees'].map(singular)).toEqual(['wolf', 'knife', 'mouse', 'octopus', 'bus', 'Thomas', 'glowing fish', 'burning tree']);
  });

  // Revize fáze 3, nález 3: „horses“ dávalo „hors“ a „cyclops“ „cyclop“ – teď jím prochází každý popisek režiséra.
  it('drops only the -s of -se words, keeps -s singulars and changes nothing on a second pass', () => {
    const words = ['horses', 'wild horses', 'houses', 'burning houses', 'roses', 'glasses', 'boxes', 'torches', 'bushes', 'buses', 'viruses', 'cactuses', 'cyclops', 'lens', 'gas', 'species', 'news'];
    expect(words.map(singular)).toEqual(['horse', 'wild horse', 'house', 'burning house', 'rose', 'glass', 'box', 'torch', 'bush', 'bus', 'virus', 'cactus', 'cyclops', 'lens', 'gas', 'species', 'news']);
    for (const word of words) expect(singular(singular(word)), word).toBe(singular(word));
    expect(draftOf('A farmer escapes from wild horses on a ranch').genre.cast?.[0]?.label).toBe('wild horse');
  });

  // Revize fáze 3, kolo 2, nález 3: zúžené pravidlo -se zkazilo -us a -s slova („bonuses“ → „bonuse“).
  it('makes -us, -as, -is and -se plurals singular alike, and a second pass changes nothing', () => {
    const table: [string, string][] = [
      ['bonuses', 'bonus'], ['hippopotamuses', 'hippopotamus'], ['angry hippopotamuses', 'angry hippopotamus'], ['campuses', 'campus'],
      ['platypuses', 'platypus'], ['crocuses', 'crocus'], ['geniuses', 'genius'], ['atlases', 'atlas'], ['canvases', 'canvas'],
      ['irises', 'iris'], ['biases', 'bias'], ['quizzes', 'quiz'], ['buses', 'bus'], ['viruses', 'virus'], ['octopuses', 'octopus'],
      ['cactuses', 'cactus'], ['walruses', 'walrus'], ['circuses', 'circus'], ['gases', 'gas'], ['lenses', 'lens'],
      ['horses', 'horse'], ['wild horses', 'wild horse'], ['houses', 'house'], ['burning houses', 'burning house'], ['blouses', 'blouse'],
      ['causes', 'cause'], ['fuses', 'fuse'], ['roses', 'rose'], ['cases', 'case'], ['vases', 'vase'], ['noses', 'nose'],
      ['glasses', 'glass'], ['boxes', 'box'], ['torches', 'torch'], ['bushes', 'bush'], ['buzzes', 'buzz'],
      ['cyclops', 'cyclops'], ['lens', 'lens'], ['gas', 'gas'], ['bias', 'bias'], ['iris', 'iris'], ['bonus', 'bonus'],
      ['species', 'species'], ['news', 'news'], ['candles', 'candle'], ['wolves', 'wolf'], ['zombies', 'zombie'], ['dummies', 'dummy'],
    ];
    expect(table.map(([word]) => [word, singular(word)])).toEqual(table);
    for (const [word, one] of table) expect(singular(one), word).toBe(one);
    expect(draftOf('A robot collects bonuses in a factory').spec.objective.description).not.toMatch(/bonuse\b/);
  });

  const demand = JSON.parse(readFileSync('evals/play/demand/corpus.json', 'utf8')) as { readonly text: string }[];
  it.each([...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text)])('writes singular role labels: %s', (text) => {
    const genre = draftGameSpecWithMeta(text).genre;
    for (const { label } of genre?.cast ?? []) expect(singular(label), `${text}: ${label}`).toBe(label);
  });
});

describe('the thing the player uses is never a role', () => {
  const FIRE = sentence('firefighter');
  const WATER_CHASES: GenreSpec = {
    genre: 'quest',
    mode: 'spatial',
    hero: 'firefighter robot',
    cast: [
      { label: 'water', does: 'chase_me' },
      { label: 'burning trees', does: 'reach', verb: 'extinguish', states: 2 },
    ],
    setting: 'burning forest',
    params: { chasers: 2 },
  };
  /** Protivníci obsazení – role, ve kterých by nástroj hráče honil nebo překážel. */
  const foes = (genre: GenreSpec): string[] => (genre.cast ?? []).filter((item) => ['shoot_at', 'chase_me', 'avoid', 'fight'].includes(item.does)).map((item) => item.label);

  it('reads the tools out of the sentence', () => {
    const texts = [FIRE, 'A kid throws water balloons at bullies', 'An elf shoots arrows at goblins', 'Shoot the zombies in a mall', 'A cat swings from vines'];
    expect(texts.map(toolsOf)).toEqual([['water'], ['water balloon'], ['arrow'], [], []]);
    expect(toolsOf('A bully throws rocks while a kid throws snowballs')).toEqual(['rock', 'snowball']);
  });

  // B-R12, třetí přístup: dvě opravy čtení podmětu padly („She's spraying“, „Firefighters spray“ bez hrdiny).
  // Pravidlo teď podmět nečte vůbec – předmět slovesa nástroje nikdy nehoní, ať ho vrhá kdokoli.
  it('never lets the object of a tool verb chase, whoever does the verb', () => {
    const toolIssue = expect.objectContaining({ code: 'CAST_IS_TOOL' });
    const chasing = (label: string) => ({ label, does: 'chase_me' as const });
    const WATER = [
      'A firefighter robot runs into the forest and she sprays water at burning trees',
      'The player sprays water at burning trees in a forest',
      "She's spraying water at burning trees in a forest",
      "I'm spraying water at burning trees in a forest",
      "We're firefighters spraying water at burning trees",
      "You're spraying water at burning fires in a city",
      'Anna sprays water at burning trees in a forest',
      'Firefighters spray water at burning trees in a forest',
    ];
    for (const text of WATER) {
      expect(toolsOf(text), text).toEqual(['water']);
      expect(foes(draftOf(text).genre), text).not.toContain('water');
      expect(readRoles(text).hazard, text).not.toBe('water');
      const quick = draftOf(text).genre;
      expect(fidelity({ ...quick, cast: [chasing('water'), ...(quick.cast ?? [])] }, text), text).toContainEqual(toolIssue);
    }
    expect(readRoles('A firefighter runs inside and she sprays water at the fire').hazard).toBe('fire');
    // Obr kámen hází, kámen proto nikoho nehoní – obr sám honit smí (revize T7, nález 6).
    for (const giantText of ['An angry giant throws rocks at the village', 'An angry giant who hates the hero throws rocks at the village', 'An angry giant roars and throws rocks at the village']) {
      const giant = draftOf(giantText).genre;
      expect(foes(giant), giantText).not.toContain('rock');
      expect(fidelity({ ...giant, hero: 'villager', cast: [chasing('rock')] }, giantText), giantText).toContainEqual(toolIssue);
      expect(fidelity({ ...giant, hero: 'villager', cast: [chasing('angry giant')] }, giantText), giantText).not.toContainEqual(toolIssue);
    }
    expect(toolsOf('Goblins that chase the player throw spears in a cave')).toEqual(['spear']);
    expect(toolsOf('A knight fights a dragon that throws fireballs')).toEqual(['fireball']);
    for (const text of ['defend a castle and throw snowballs at dragons', 'Throw snowballs at snowmen in a park', 'defend a castle from dragons by throwing snowballs', 'Play as a kid who throws snowballs at bullies']) {
      expect(toolsOf(text), text).toEqual(['snowball']);
    }
    expect(toolsOf('fps where u shoot paint at robots')).toEqual(['paint']);
  });

  it('rejects an answer whose chaser is the water the firefighter sprays, with the reason', () => {
    const read = readGenreAnswer(answer(WATER_CHASES));
    if (!read.ok) throw new Error(read.detail);
    expect(read.spec.objective.description).toContain('before the water catch');
    expect(fidelity(read.genre, FIRE)).toContainEqual(expect.objectContaining({ code: 'CAST_IS_TOOL', path: '/cast/0', evidence: expect.stringContaining('"water"') }));
  });

  it('repairs it with the enemy and the chaser count of the sentence, so the water never chases the firefighter', async () => {
    const game = await directed(FIRE, WATER_CHASES);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(game.spec.roles.map((role) => role.label)).not.toContain('water');
    // P36A T3: úkol v prostoru má vždy pronásledovatele – výchozího jednoho, s nepřítelem z věty, ne s vodou.
    expect(game.spec.roles).toContainEqual(expect.objectContaining({ label: 'fallen log' }));
    const evidence = await actionEvidence(game.spec, 1);
    expect(evidence).toContainEqual(expect.objectContaining({ verb: 'jump' }));
    expect(game.unmet).toEqual(missingActions(extractIntent(FIRE), evidence));
    expect(game.unmet!.length).toBeGreaterThan(0);
  });

  it('keeps the quick version off the tool too', () => {
    expect(draftOf(FIRE).spec.roles.map((role) => role.label)).not.toContain('water');
    // Od P36A T10 Střílečka: goblini jdou ve vlnách jako nepřítel, šíp není role.
    const elf = draftOf('An elf shoots arrows at goblins in a forest');
    expect(elf.genre).toMatchObject({ genre: 'shooter', cast: expect.arrayContaining([{ label: 'goblin', does: 'shoot_at' }]) });
    // P42: pojmenovaný náboj je munice (role `ammunition`, druh item) – šíp je čím hráč střílí, nikdy nepřítel.
    expect(elf.spec.roles.filter((role) => role.label === 'arrow')).toEqual([expect.objectContaining({ id: 'ammunition', kind: 'item' })]);
  });
});

describe('the AI version adds what the sentence says and the quick version misses', () => {
  const SNOW = 'A kid throws snowballs at a snowman while a dog chases him';

  it('asks for it in both prompt forms', () => {
    const quick = draftOf(SNOW).genre;
    for (const request of [buildDirectorRequest(SNOW, quick), buildCompactRequest(SNOW, quick, true)]) {
      expect(request.system).toContain('LIVE COMBINATIONS');
      expect(request.system).toContain('unmet');
      expect(request.system).toContain('Cast labels are singular');
      expect(request.system).toContain('A cast thing is never what the player holds, sprays or throws');
    }
  });

  // P36A T3: rychlá verze honiče už nemine – výchozí pronásledovatel úkolu nese nepřítele z věty (psa).
  // Odpověď, která psa nechá, se hraje jako autorská a psa nese dál. Do P36A T10 to byla věta SNOW; hod je teď
  // vlastní žánr bez honiče, takže prostorový úkol nese praskání balónků. P42 větu skládá jako běh s honičem
  // a balónky jako díl; odpověď je rychlá verze, jak je – `chasers` má jen úkol, běžec ho odmítne (i na main).
  it('plays the chaser the sentence names – the quick version already has it as the default quest chaser', async () => {
    const CHASED = 'A kid pops balloons at a fair while a dog chases him';
    const quick = draftOf(CHASED);
    expect(quick.spec.roles).toContainEqual(expect.objectContaining({ kind: 'chaser', label: 'dog' }));
    const game = await directed(CHASED, quick.genre!);
    expect(game.source).toBe('authored');
    expect(game.spec.roles).toContainEqual(expect.objectContaining({ kind: 'chaser', label: 'dog' }));
    expect(game.unmet).toEqual(missingActions(extractIntent(CHASED), await actionEvidence(game.spec, 1)));
  });
});

// Revize P32 (stopa A): AI verze lyžařky jela, jen když model sám napsal `ride: 1`.
describe('the runner rides by the sentence, not by the model', () => {
  const SKIS = 'A girl skis down the slope';
  const RUNS = 'A boy runs through the city and avoids cars';

  it('rides in the quick version of a riding sentence', () => {
    expect(draftGameSpec(SKIS).theme.motion).toBe('ride');
  });

  it('rides in the AI version of a riding sentence the model wrote without ride', () => {
    const quick = draftOf(SKIS).genre;
    expect(quick.genre).toBe('runner');
    const { params: _params, ...written } = quick;
    const read = readGenreAnswer(answer(written as GenreSpec), undefined, SKIS);
    if (!read.ok) throw new Error(read.detail);
    expect(read.spec.theme.motion).toBe('ride');
  });

  it('hands the sentence to the read, so the directed game rides too', async () => {
    const { params: _params, ...written } = draftOf(SKIS).genre;
    const game = await directed(SKIS, written as GenreSpec);
    expect(game.source).toBe('authored');
    expect(game.spec.theme.motion).toBe('ride');
  });

  it('keeps a running sentence on foot even when the model wrote ride: 1', () => {
    const quick = draftOf(RUNS).genre;
    expect(quick.genre).toBe('runner');
    expect(draftGameSpec(RUNS).theme).not.toHaveProperty('motion');
    const read = readGenreAnswer(answer({ ...quick, params: { ...quick.params, ride: 1 } } as GenreSpec), undefined, RUNS);
    if (!read.ok) throw new Error(read.detail);
    expect(read.spec.theme).not.toHaveProperty('motion');
    expect(read.genre.params ?? {}).not.toHaveProperty('ride');
  });
});

// Přejímka O10 kolo 1: AI verze skákačky se sbíráním ukazovala „Reach the flag“ – model nenapsal `target`.
describe('the platformer keeps the sentence’s item and goal when the model leaves them out (P35 T9)', () => {
  // Tři, ne pět: pět je výchozí počet a nedokázalo by, že počet přišel z věty.
  const GRAB = 'A bunny hops over hedges to grab three shiny apples';
  const REACH = 'A squirrel jumps across rooftops to reach the old lighthouse';
  const read = (text: string, written: GenreSpec) => {
    const result = readGenreAnswer(answer(written), undefined, text);
    if (!result.ok) throw new Error(result.detail);
    return result;
  };

  /** Obsazení bez věci ke sběru a bez cíle – co model u skákačky vynechává. */
  const withoutGoal = (genre: GenreSpec): GenreSpec['cast'] => genre.cast?.filter((item) => item.does !== 'collect' && item.does !== 'reach');

  it('reads the item, the goal and the count in the quick version', () => {
    const quick = draftOf(GRAB);
    // Sbírací sloveso nese sama věc (P39 T7): cíl se jménem věci by obsazení bez dvojic zahodilo.
    expect(quick.genre).toMatchObject({ genre: 'platformer', cast: expect.arrayContaining([{ label: 'shiny apple', does: 'collect', verb: 'grab' }]) });
    expect(quick.spec.tutorial.goalLine).toBe('Collect 3 shiny apples and reach the flag.');
    expect(draftOf(REACH).spec.tutorial.goalLine).toBe('Reach the old lighthouse.');
  });

  it('plays the quick version’s goal when the model wrote neither item, goal nor count', () => {
    for (const text of [GRAB, REACH]) {
      const quick = draftOf(text);
      const { counts: _counts, params: _params, ...written } = quick.genre;
      const { spec } = read(text, { ...written, cast: withoutGoal(quick.genre) } as GenreSpec);
      expect(spec.tutorial.goalLine, text).toBe(quick.spec.tutorial.goalLine);
      expect(spec.objective.description, text).toBe(quick.spec.objective.description);
      expect(spec.roles.find((role) => role.id === 'finish')?.label, text).toBe(quick.spec.roles.find((role) => role.id === 'finish')?.label);
      expect(spec.roles.find((role) => role.id === 'coin')?.label, text).toBe(quick.spec.roles.find((role) => role.id === 'coin')?.label);
    }
  });

  // Model napsal vlastní věc bez slovesa: sbírací sloveso rychlé verze přejde na ni, věc se cílem úrovně nestane.
  it('collects the model’s own item when only the goal is missing, without making the item the goal', () => {
    const written = draftOf(GRAB).genre;
    const { spec } = read(GRAB, { ...written, cast: [...withoutGoal(written)!, { label: 'apple', does: 'collect' }] } as GenreSpec);
    expect(spec.tutorial.goalLine).toBe('Collect 3 apples and reach the flag.');
  });

  // Bez věci: s věcí by `goalOfSentence` skončila dřív a test by přepis cíle nechytil.
  it('keeps a goal the model wrote itself', () => {
    const written = draftOf(REACH).genre;
    const { spec } = read(REACH, { ...written, cast: [...(withoutGoal(written) ?? []), { label: 'chimney', does: 'reach', verb: 'reach', states: 2 }] } as GenreSpec);
    expect(spec.tutorial.goalLine).toBe('Reach the chimney.');
  });

  it('keeps a count the model wrote itself', () => {
    const { params: _params, ...written } = draftOf(GRAB).genre;
    const { spec } = read(GRAB, { ...written, counts: { ...written.counts, collectible: 4 } } as GenreSpec);
    expect(spec.tutorial.goalLine).toBe('Collect 4 shiny apples and reach the flag.');
  });

  it('hands the sentence to the read, so the directed game has the goal too', async () => {
    const quick = draftOf(GRAB);
    const cast = quick.genre.cast!.map(({ verb: _verb, ...item }) => item);
    const game = await directed(GRAB, { ...quick.genre, cast } as GenreSpec);
    expect(game.source).toBe('authored');
    expect(game.spec.tutorial.goalLine).toBe(quick.spec.tutorial.goalLine);
  });
});

/**
 * P39: AI verze smí obsadit věc věty, kterou rychlá verze nemá, a hraje ji –
 * kritik ji do rychlé verze nevrátí (dřív `critic.ts:413` soudil podle ní).
 */
describe('the AI version plays a cast thing of the sentence the quick version missed', () => {
  const WATCH = 'a fox jumps over logs while animals watch in the forest';

  it('shoots the animals the sentence names, where the quick version only jumps logs', async () => {
    const quick = draftOf(WATCH);
    expect(quick.spec.addons ?? []).not.toContain('shoot');
    const game = await directed(WATCH, { ...quick.genre, cast: [...quick.genre.cast!, { label: 'animals', does: 'shoot_at' }] });
    expect(game.source).toBe('authored');
    expect(game.unmet).toEqual(missingActions(extractIntent(WATCH), await actionEvidence(game.spec, 1)));
    expect(game.spec.addons).toContain('shoot');
    expect(game.spec.roles).toContainEqual(expect.objectContaining({ id: 'enemy', label: 'animal' }));
  });
});

/**
 * P39 T14: prompt zakazuje obsadit, co hráč hází, takže odpověď náboj nemá – a hod
 * pak vzal první sbíranou věc (žaludy místo šišek). Náboj doplní rychlá verze.
 */
describe('the AI version throws what the sentence throws', () => {
  const SQUIRREL = 'a squirrel grabs acorns, dodges owls and throws pinecones at a fox';
  const ballOf = (spec: { readonly roles: readonly { readonly id: string; readonly label: string }[] }) => spec.roles.find((role) => role.id === 'ball')?.label;

  it('throws the pinecones the answer left out, not the acorns it collects', async () => {
    const quick = draftOf(SQUIRREL);
    expect(quick.genre.genre).toBe('throw');
    const game = await directed(SQUIRREL, { ...quick.genre, cast: quick.genre.cast!.filter((item) => !isAmmo(item)) });
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(ballOf(game.spec)).toBe('pinecone');
    expect(game.unmet).toEqual(missingActions(extractIntent(SQUIRREL), await actionEvidence(game.spec, 1)));
  });

  // Odpověď s náhradním nábojem mimo větu neprojde věrností; oprava ho zahodí a náboj z věty musí přijít i potom.
  it('throws the pinecones after the repair drops an ammo the sentence never said', async () => {
    const quick = draftOf(SQUIRREL);
    const cast = quick.genre.cast!.map((item) => (isAmmo(item) ? { ...item, label: 'snowball' } : item));
    const game = await directed(SQUIRREL, { ...quick.genre, cast });
    expect(game.source).toBe('authored');
    expect(game.failure?.reason).toBe('ACTION_LOST');
    expect(ballOf(game.spec)).toBe('pinecone');
    expect(game.unmet).toEqual(missingActions(extractIntent(SQUIRREL), await actionEvidence(game.spec, 1)));
  });
});

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
