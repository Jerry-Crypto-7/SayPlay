/**
 * **Planner (P13 T10).** Sada je `pin`, protože vada, kterou tu hledáme, není
 * vidět: strukturálně bezvadný plán může být opsaná ukázka, může to být stará
 * emise v jiném kabátě, a systémová zpráva může modelu tiše prozradit slovník
 * geometrie a tím obě fáze slít v jednu.
 *
 * Čtyři tvrzení, každé s vlastní protipůlkou:
 *
 *   1. **Požadavek nese doopravdy tu větu uživatele.** Zkouší se nad **celou**
 *      zmrazenou create sadou, ne nad jednou hezkou větou — přesně tak vznikla
 *      vada, kdy prompt zmizel v šabloně a nikdo si toho nevšiml.
 *   2. **Požadavek nemluví o geometrii.** Kdyby ano, planner by geometrii začal
 *      navrhovat a §10.1 by neexistovala. Soudí se lexikálně nad uzavřeným
 *      seznamem, a ten seznam sám se ověřuje proti falešně negativnímu tvaru.
 *   3. **Plán nesmí být celý `WorldDoc`.** To je nejsilnější zvyk modelu.
 *   4. **Kopie ukázky se odmítá** — doslovná i „jen jsem si půjčil jména".
 *
 * Co se tu **nedokazuje:** že model odpovídá dobře. Tahle sada nemá model;
 * měří se to živě v T14. Tady se hlídá kontrakt, ne kvalita.
 */

import { describe, expect, it } from 'vitest';

import { readCorpus } from '../../../evals/worldstream/lock.mjs';
import { EXAMPLE_ONLY_IDENTIFIERS, EXAMPLE_PLAN } from '../worldstream-examples';
import {
  GEOMETRY_VOCABULARY,
  INTENT_ROLES,
  PLANNER_STAGE,
  buildIntentRequest,
  containsGeometryVocabulary,
  readPlannerEmission,
  type PlannerEmission,
} from '../worldstream-intent';

const CORPUS = readCorpus();

/** Plán, který projde. Testy si z něj berou kopii a kazí jednu věc. */
const VALID_PLAN = {
  intent: {
    setting: 'a night market folded into a disused railway cutting',
    mood: 'warm, crowded, a little illegal',
    spatialThesis:
      'The stalls line both retaining walls and the old track bed is the only aisle, so the crowd moves in one direction and the walls do the selling.',
    actors: ['the stallholders', 'the crowd'],
    heroObjects: ['the retaining wall of stalls'],
    interactions: ['a shutter rolls up and the stall behind it lights the cutting'],
    unsupported: ['the crowd is a density, not individually simulated people'],
  },
  objects: [
    {
      stableId: 'cuttingWall',
      label: 'the retaining wall of stalls',
      synonyms: ['the wall', 'the stalls', 'the stall wall'],
      role: 'architecture',
      importance: 3,
    },
    {
      stableId: 'trackBed',
      label: 'the old track bed',
      synonyms: ['the aisle', 'the track', 'the ground'],
      role: 'terrain',
      importance: 2,
    },
  ],
} as const;

function planWith(mutate: (plan: Record<string, unknown>) => void): unknown {
  const plan = JSON.parse(JSON.stringify(VALID_PLAN)) as Record<string, unknown>;
  mutate(plan);
  return plan;
}

describe('1. požadavek nese větu uživatele a nic jí nepřebíjí', () => {
  it('doslovný prompt stojí v každém z třiceti zmrazených případů', () => {
    expect(CORPUS.create.length).toBe(30);
    for (const testCase of CORPUS.create) {
      const request = buildIntentRequest(testCase.prompt);
      expect(request.user, testCase.id).toContain(testCase.prompt);
    }
  });

  it('prompt stojí až za zákazem opisování, ne před ním', () => {
    // Pořadí je celý mechanismus: naměřeno v P12, že malý model si drží konec
    // zprávy. Kdyby zákaz stál za zadáním, opisoval by do prázdna.
    const sentence = 'a lighthouse built from stacked fishing boats';
    const { user } = buildIntentRequest(sentence);
    const ban = user.indexOf('Do not reuse these example-only names');
    const request = user.indexOf(sentence);

    // Obě `toBeGreaterThan(-1)` tu MUSÍ být. `indexOf` vrací -1, když text
    // chybí, a `-1 < cokoliv` je pravda — takže bez nich by tahle aserce byla
    // zelená i nad zprávou, ze které zákaz úplně vypadl. Naměřeno mutací
    // 31. 8. 2026: přesně ten mutant tudy prošel.
    expect(ban).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(-1);
    expect(ban).toBeLessThan(request);
  });

  it('prompt se nedostane do systémové zprávy — ta je pro všechny věty stejná', () => {
    const first = buildIntentRequest(CORPUS.create[0].prompt);
    const second = buildIntentRequest(CORPUS.create[1].prompt);
    expect(first.system).toBe(second.system);
  });

  it('model požadavku je pojmenovaný, ne prázdný', () => {
    expect(buildIntentRequest('a quiet room').model.length).toBeGreaterThan(0);
  });
});

describe('2. požadavek nemluví o geometrii — hranice fází, ne vkus', () => {
  it('systémová ani uživatelská zpráva nenese slovo z uzavřeného seznamu', () => {
    const request = buildIntentRequest(CORPUS.create[0].prompt);
    expect(containsGeometryVocabulary(request.system)).toEqual([]);
    expect(containsGeometryVocabulary(request.user)).toEqual([]);
  });

  it('žádná ze třiceti vět slovník neprotáhne dovnitř', () => {
    // Věta uživatele slovo o geometrii nést SMÍ („a box of matches"); zprávu tím
    // ale neznečistí, protože se do ní vkládá doslova a nic z ní neodvozujeme.
    for (const testCase of CORPUS.create) {
      const request = buildIntentRequest(testCase.prompt);
      const leaked = containsGeometryVocabulary(request.system);
      expect(leaked, `${testCase.id} protáhl ${leaked.join(', ')}`).toEqual([]);
    }
  });

  it('detektor doopravdy hledá — jinak by byl bod výš zelený nadarmo', () => {
    for (const word of GEOMETRY_VOCABULARY)
      expect(containsGeometryVocabulary(`we then ${word} the thing`), word).toContain(word);
  });

  it('detektor soudí celá slova, ne podřetězce', () => {
    // „boxing", „meshuggah" ani „gridiron" nejsou instrukce pro geometrii.
    // Bez hranic slov by tahle sada hlásila poplach nad běžnou angličtinou.
    expect(containsGeometryVocabulary('a boxing gym under a gridiron stadium')).toEqual([]);
  });
});

describe('3. plán není svět — stará emise se odmítá jmenovitě', () => {
  for (const field of ['irVersion', 'sim', 'look', 'simRevision', 'lookRevision'])
    it(`odpověď s polem ${field} se odmítne jako špatná fáze`, () => {
      const result = readPlannerEmission(planWith((plan) => void (plan[field] = {})));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('WORLD_DOC_RETURNED');
      expect(result.detail).toContain(field);
    });

  it('celý WorldDoc se odmítne dřív, než se začne řešit chybějící intent', () => {
    // Tohle je ta aserce, kvůli které je pořadí kontrol součástí kontraktu:
    // obecná kontrola tvaru by odpověděla „chybí intent" a sebeoprava by
    // dopsala prázdný intent místo toho, aby změnila fázi.
    const worldDoc = { irVersion: 3, simRevision: 1, lookRevision: 1, sim: {}, look: {} };
    const result = readPlannerEmission(worldDoc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('WORLD_DOC_RETURNED');
  });
});

describe('4. opsaná ukázka je strukturálně platná a je to špatná odpověď', () => {
  it('doslovná kopie ukázky se odmítne', () => {
    const result = readPlannerEmission(JSON.parse(JSON.stringify(EXAMPLE_PLAN)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('EXAMPLE_COPIED');
  });

  it('půjčené jméno objektu se odmítne i ve zbytku vlastním plánu', () => {
    // Tohle je ta zákeřná polovina: plán je jinak celý o noční tržnici a jen
    // jeden objekt je z ukázky. Doslovné porovnání celého dokumentu ho mine.
    const result = readPlannerEmission(
      planWith((plan) => {
        (plan.objects as Record<string, unknown>[])[0].stableId = 'telescopeMount';
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('EXAMPLE_COPIED');
    expect(result.detail).toContain('telescopeMount');
  });

  it('půjčený label se odmítne stejně jako půjčené stableId', () => {
    const result = readPlannerEmission(
      planWith((plan) => {
        (plan.objects as Record<string, unknown>[])[0].label = 'the frozen lake';
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('EXAMPLE_COPIED');
  });

  it('zakázaná jména jsou doopravdy jména z ukázky, ne prázdný seznam', () => {
    expect(EXAMPLE_ONLY_IDENTIFIERS.length).toBe(EXAMPLE_PLAN.objects.length * 2);
    expect(EXAMPLE_ONLY_IDENTIFIERS).toContain('observatoryShell');
    expect(EXAMPLE_ONLY_IDENTIFIERS).toContain('the glass dome');
  });
});

describe('5. kontrakt plánu se vynucuje, ne jen popisuje', () => {
  it('platný plán projde a nese značku fáze', () => {
    const result = readPlannerEmission(planWith(() => {}));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.stage).toBe(PLANNER_STAGE);
    expect(result.stage).not.toBe('emission');
    expect(result.value.objects[0].synonyms.length).toBeGreaterThan(0);
  });

  for (const field of ['setting', 'mood', 'spatialThesis'])
    it(`prázdné intent.${field} neprojde`, () => {
      const result = readPlannerEmission(
        planWith((plan) => void ((plan.intent as Record<string, unknown>)[field] = '   ')),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('WRONG_SHAPE');
      expect(result.detail).toContain(field);
    });

  it('chybějící unsupported neprojde — mlčení není totéž co „nic jsem neabstrahoval"', () => {
    const result = readPlannerEmission(
      planWith((plan) => void delete (plan.intent as Record<string, unknown>).unsupported),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toContain('unsupported');
  });

  it('prázdné unsupported projde — občas je to pravda a je to rozhodnutí', () => {
    const result = readPlannerEmission(
      planWith((plan) => void ((plan.intent as Record<string, unknown>).unsupported = [])),
    );
    expect(result.ok).toBe(true);
  });

  it('objekt bez synonym neprojde — druhá věta by neměla čím cílit', () => {
    const result = readPlannerEmission(
      planWith((plan) => void delete (plan.objects as Record<string, unknown>[])[0].synonyms),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toContain('synonyms');
  });

  it('role mimo pět povolených neprojde', () => {
    const result = readPlannerEmission(
      planWith((plan) => void ((plan.objects as Record<string, unknown>[])[0].role = 'scenery')),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('WRONG_SHAPE');
    expect(result.detail).toContain('scenery');
  });

  it('importance mimo 0..3 neprojde, a řetězec taky ne', () => {
    for (const bad of [4, -1, 1.5, '2', null]) {
      const result = readPlannerEmission(
        planWith((plan) => void ((plan.objects as Record<string, unknown>[])[0].importance = bad)),
      );
      expect(result.ok, String(bad)).toBe(false);
    }
  });

  it('plán bez objektů se odmítne vlastním důvodem', () => {
    const result = readPlannerEmission(planWith((plan) => void (plan.objects = [])));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('EMPTY_PLAN');
  });

  it('pole ani null místo objektu se nepřevlékne za plán', () => {
    for (const bad of [null, [], 'a plan', 42])
      expect(readPlannerEmission(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe('6. ukázka učí všech pět rolí, protože to je jediné, co je učí', () => {
  it('každá role stojí v ukázce právě jednou', () => {
    const roles = EXAMPLE_PLAN.objects.map((object) => object.role);
    expect([...roles].sort()).toEqual([...INTENT_ROLES].sort());
  });

  it('ukázka sama projde vlastním kontraktem, až na to, že je to ukázka', () => {
    // Kdyby ukázka kontrakt nesplňovala, učila by model tvar, který pak sama
    // odmítne. Ověřuje se to přejmenováním, aby nespadla na zákazu kopie.
    const renamed = JSON.parse(JSON.stringify(EXAMPLE_PLAN)) as PlannerEmission;
    const objects = renamed.objects as unknown as Record<string, unknown>[];
    for (const [index, object] of objects.entries()) {
      object.stableId = `renamed${index}`;
      object.label = `renamed label ${index}`;
    }
    const result = readPlannerEmission(renamed);
    expect(result.ok, result.ok ? '' : result.detail).toBe(true);
  });

  it('unsupported v ukázce jmenuje konkrétní abstrakce, ne omluvu', () => {
    // Model kopíruje TÓN ukázky, i když nekopíruje obsah. Kdyby tu stálo
    // „some limitations apply", vyrobilo by to prázdné seznamy napořád.
    expect(EXAMPLE_PLAN.intent.unsupported.length).toBeGreaterThan(0);
    for (const entry of EXAMPLE_PLAN.intent.unsupported) {
      expect(entry.split(' ').length, entry).toBeGreaterThan(5);
      expect(entry.toLowerCase()).not.toContain('limitation');
      expect(entry.toLowerCase()).not.toContain('not supported');
    }
  });
});
