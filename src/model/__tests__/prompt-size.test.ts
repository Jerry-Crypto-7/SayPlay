/**
 * **Co ze zadání smí zmizet a co nikdy (P21 T7).**
 *
 * Zkrácené zadání projde každým testem, který soudí odpovědi, a přitom může
 * modelu sebrat přesně to, co drželo kvalitu — pozná se to až na horších
 * světech o den později. Tenhle soubor proto pojmenovává **povinné části**:
 * co v požadavku být musí, aby kus uměl napsat svoje pole, a co v něm být
 * nesmí, aby se nepsalo dvakrát.
 *
 * Řez je týž jako u slepování (`CHUNK_FIELDS`): kus, který pole nepíše,
 * nedostane ani jeho slovník. Kdyby ho dostal, psal by ho — a `mergeEmissionChunks`
 * by celou odpověď odmítla jako `FIELD_NOT_IN_CHUNK`.
 */

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '../client';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';
import { CHUNK_FIELDS, EMISSION_CHUNKS } from '../emission-merge';
import {
  BLUEPRINT_EXAMPLE_MARKER,
  COMPILER_ANSWER_FIELDS,
  EXAMPLE_BLUEPRINT_ANSWER,
  WORLD_CONTRACT_MARKER,
  buildCompilerRequest,
  geometryVocabulary,
  capabilityManifest,
  mentionsWeather,
  requestStage,
  shapeVocabulary,
} from '../worldstream-prompt';
import { readPlannerEmission } from '../worldstream-intent';
import fixture from '../__fixtures__/archived-compiler-answer.json';

const grammarRead = frozenGrammar();
if (!grammarRead.ok) throw new Error(`frozen grammar unreadable: ${grammarRead.detail}`);
const GRAMMAR: Grammar = grammarRead.value;

function plan() {
  const parsed = readPlannerEmission(fixture.plan, { requireSceneSpec: false });
  if (!parsed.ok) throw new Error(`archivovaný plán se nepřečetl: ${JSON.stringify(parsed).slice(0, 200)}`);
  return parsed.value;
}

const whole = () => buildCompilerRequest(plan(), GRAMMAR);
const forChunk = (chunk: (typeof EMISSION_CHUNKS)[number]) => buildCompilerRequest(plan(), GRAMMAR, chunk);

describe('povinné části zadání', () => {
  it('celá odpověď dál dostane všechno, co potřebuje napsat', () => {
    const request = whole();
    expect(requestStage(request)).toBe('compiler');
    expect(request.system).toContain(`${COMPILER_ANSWER_FIELDS.join(', ')}.`);
    expect(request.system).toContain(geometryVocabulary());
    expect(request.system).toContain(shapeVocabulary());
    expect(request.system).toContain(capabilityManifest());
    expect(request.system).toContain(WORLD_CONTRACT_MARKER);
    expect(request.system).toContain(BLUEPRINT_EXAMPLE_MARKER);
    for (const field of Object.keys(EXAMPLE_BLUEPRINT_ANSWER)) expect(request.system).toContain(`"${field}"`);
    expect(request.user).toContain('needs a placement');
  });

  it('kus dostane slovník k polím, která píše, a k žádným jiným', () => {
    for (const chunk of EMISSION_CHUNKS) {
      const system = forChunk(chunk).system;
      const mine = CHUNK_FIELDS[chunk];
      expect(system.includes(geometryVocabulary()), `${chunk}: slovník kompozice`).toBe(mine.includes('geometry') || mine.includes('architecture'));
      expect(system.includes(shapeVocabulary()), `${chunk}: slovník tvarů`).toBe(mine.includes('shapes'));
      expect(system.includes(WORLD_CONTRACT_MARKER), `${chunk}: kontrakt světa`).toBe(mine.includes('world'));
      expect(system.includes('PLACEMENTS bind the two together'), `${chunk}: pravidla placementů`).toBe(mine.includes('placements'));
    }
  });

  it('ukázka je zúžená rozsahem, ne formátem — odsazení zůstává', () => {
    for (const chunk of EMISSION_CHUNKS) {
      const system = forChunk(chunk).system;
      const example = system.slice(system.indexOf(BLUEPRINT_EXAMPLE_MARKER));
      for (const field of Object.keys(EXAMPLE_BLUEPRINT_ANSWER))
        expect(example.includes(`\n  "${field}"`), `${chunk}: ukázka pole ${field}`).toBe(CHUNK_FIELDS[chunk].includes(field));
      // Odsazení je naměřená podmínka kvality (viz komentář u ukázky), takže
      // zúžení se nesmí svézt se zkompaktněním.
      expect(example).toContain('\n      ');
    }
  });

  it('kontrakt světa se vkládá bez vlastního ukázkového světa a bez nabídky odmítnout', () => {
    const system = whole().system;
    expect(system).not.toContain(EXAMPLE_MARKER);
    expect(system).not.toContain('simOutcome: "NO_FIT"');

    // Ta ukázka se nevypouští proto, že by byla zbytečná, ale proto, že tytéž
    // fáze ukazuje ukázkový blueprint ve svém poli `world`. Kdyby z něj jedna
    // zmizela, tenhle test spadne dřív, než se model začne mýlit.
    const exampleWorld = (EXAMPLE_BLUEPRINT_ANSWER as unknown as { world: { sim: object; look: object } }).world;
    const contract = buildEmissionRequest('', GRAMMAR).system;
    const demonstrated = contract.slice(contract.indexOf(EXAMPLE_MARKER));
    for (const field of [...Object.keys(exampleWorld.sim), ...Object.keys(exampleWorld.look)])
      expect(demonstrated.includes(`"${field}"`), `pole ${field} ukazuje jen vypuštěná ukázka`).toBe(true);
    const demonstratedFields = [...demonstrated.matchAll(/^ {4}"(\w+)":/gm)];
    // Bez tohohle by prázdná shoda udělala z cyklu pod ním ozdobu.
    expect(demonstratedFields.length).toBeGreaterThan(8);
    for (const match of demonstratedFields)
      expect(
        [...Object.keys(exampleWorld.sim), ...Object.keys(exampleWorld.look)],
        `pole ${match[1]} ukazovala jen vypuštěná ukázka kontraktu`,
      ).toContain(match[1]);
  });

  it('holá věta nabídku odmítnout dál má', () => {
    const request = buildEmissionRequest('a room', GRAMMAR);
    expect(request.system).toContain('simOutcome: "NO_FIT"');
    expect(request.system).toContain(EXAMPLE_MARKER);
  });
});

/**
 * Nabídka `lookBindings` (P22 T12) se platí jen tam, kde má smysl: zadání,
 * které mluví o počasí nebo denní době. Archivovaný plán o ničem takovém
 * nemluví, takže ji nedostane; týž plán s bouří v náladě ano – a kus, který
 * `world` nepíše, ji nedostane nikdy, protože `lookBindings` patří k `rules`.
 */
describe('nabídka lookBindings jen k počasí a denní době', () => {
  const stormy = () => {
    const base = plan();
    return { ...base, intent: { ...base.intent, mood: 'a storm gathering over the terrace' } };
  };

  it('bez počasí v zadání se lookBindings nenabízí', () => {
    expect(mentionsWeather(plan())).toBe(false);
    expect(whole().system).not.toContain('lookBindings');
  });

  it('bouře v zadání nabídku přidá, i s uzavřeným seznamem předvoleb', () => {
    expect(mentionsWeather(stormy())).toBe(true);
    const request = buildCompilerRequest(stormy(), GRAMMAR);
    expect(requestStage(request)).toBe('compiler');
    expect(request.system).toContain('lookBindings: [{ variable, values }]');
    expect(request.system).toContain('day|dusk|night|storm|fog');
  });

  it('denní světlo v místnosti není denní doba', () => {
    const base = plan();
    expect(mentionsWeather({ ...base, intent: { ...base.intent, setting: 'Daylit room', mood: 'calm daylight' } })).toBe(false);
  });

  it('kus objektů nabídku nedostane, kus pravidel ano', () => {
    // Zúžení kusu pole ostatních kusů jmenuje, takže se hledá věta nabídky, ne slovo.
    const offer = 'lookBindings: [{ variable, values }]';
    expect(buildCompilerRequest(stormy(), GRAMMAR, 'objects').system).not.toContain(offer);
    expect(buildCompilerRequest(stormy(), GRAMMAR, 'rules').system).toContain(offer);
    expect(CHUNK_FIELDS.rules).toContain('lookBindings');
  });
});
