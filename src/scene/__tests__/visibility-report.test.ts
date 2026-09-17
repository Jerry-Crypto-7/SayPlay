import { describe,expect, it } from 'vitest';
import type { RepresentationEvidence } from '@/worldstream/scene-metrics';
import { visibilityReport, type VisualObservation } from '../visibility-report';
import type { SceneSpec } from '../spec';

it('separates a missing requirement, an off-camera object and an unrecognizable object', () => {
  const spec = {instances:[{stableId:'chair'},{stableId:'person'}],requirements:[
    {description:'chair',polarity:'required',instanceIds:['chair']},
    {description:'person',polarity:'required',instanceIds:['person']},
  ]} as SceneSpec;
  const report = visibilityReport(spec,[
    {stableId:'chair',built:true,loaded:true,inFrame:false,screenPixels:0,unoccludedSamples:0,samples:5},
    {stableId:'person',built:true,loaded:true,inFrame:true,screenPixels:100,unoccludedSamples:5,samples:5},
  ],[{description:'aquarium from original brief',instanceIds:['aquarium']}],{person:false});
  expect(report.map(r=>r.instances[0].status)).toEqual(['loaded','visible','absent']);
  expect(report[1].instances[0].recognition).toBe(false);
  expect(report.every(r=>r.instances[0].repair)).toBe(true);
});

it('five chairs do not satisfy five missing people and tiny pixels are not visible evidence', () => {
  const people=Array.from({length:5},(_,i)=>`person${i}`);
  const chairs=Array.from({length:5},(_,i)=>`chair${i}`);
  const spec={instances:[...people,...chairs].map(stableId=>({stableId})),requirements:[
    {description:'five people',polarity:'required',instanceIds:people},
    {description:'five chairs',polarity:'required',instanceIds:chairs},
  ]} as SceneSpec;
  const observations=chairs.map(stableId=>({stableId,built:true,loaded:true,inFrame:true,screenPixels:10,unoccludedSamples:5,samples:5}));
  const report=visibilityReport(spec,observations);
  expect(report[0].instances.map(i=>i.status)).toEqual(Array(5).fill('planned'));
  expect(report[1].instances.map(i=>i.status)).toEqual(Array(5).fill('loaded'));
  expect(report.flatMap(r=>r.instances).every(i=>i.recognition==='unreviewed')).toBe(true);
});

/* ------------------------------------------------------------------ *
 * A3 — čtyři fixtures, každá s konkrétním stavem.
 * ------------------------------------------------------------------ */

/** Stůl je hlavní požadavek, lampa vedlejší — důležitost rozhoduje o zakrytí a velikosti. */
function room(): SceneSpec {
  const provenance = { kind: 'requested', quote: 'a reading room' } as const;
  const instance = (stableId: string, role: string, requirementIds: string[]) =>
    ({ stableId, role, requirementIds, provenance, attributes: [], orientation: { description: 'facing the door', provenance } });
  return {
    version: 1,
    requirements: [
      { id: 'desk', description: 'a desk', priority: 'main', polarity: 'required', count: 1, instanceIds: ['desk'], provenance },
      { id: 'lamp', description: 'a lamp', priority: 'secondary', polarity: 'required', count: 1, instanceIds: ['lamp'], provenance },
      { id: 'clock', description: 'a clock', priority: 'secondary', polarity: 'required', count: 1, instanceIds: ['clock'], provenance },
    ],
    instances: [instance('desk', 'hero', ['desk']), instance('lamp', 'prop', ['lamp']), instance('clock', 'hero', ['clock'])],
    relations: [], clarifications: [],
  } as unknown as SceneSpec;
}

const seen = (stableId: string, over: Partial<VisualObservation> = {}): VisualObservation =>
  ({ stableId, built: true, loaded: true, inFrame: true, screenPixels: 400, unoccludedSamples: 5, samples: 5, ...over });

const contactOf = (stableId: string, over: Partial<RepresentationEvidence> = {}): RepresentationEvidence =>
  ({ stableId, label: stableId, source: 'geom', declared: true, geometryBuilt: true, catalogResolved: null,
     loaded: 'unobserved', reason: null, instances: 1, unsupported: 0, collisions: 0, ...over });

describe('A3 — prompt → požadavek → instance → obraz', () => {
  it('fixture 1: objekt existuje, ale je mimo kameru — a jeho kontakt se hlásí dál', () => {
    const report = visibilityReport(
      room(),
      [seen('desk', { inFrame: false, screenPixels: 0, unoccludedSamples: 0 }), seen('lamp'),
       seen('clock', { screenPixels: 120, unoccludedSamples: 2 })],
      [], {},
      [contactOf('desk', { instances: 4, unsupported: 1 }), contactOf('lamp')],
    );
    const desk = report[0].instances[0];
    expect(desk.status).toBe('loaded');
    // Mimo záběr NENÍ „nepostaveno": kusy i jejich kontakt report zná dál.
    expect(desk.contact).toEqual({ instances: 4, unsupported: 1, collisions: 0 });
    expect(desk.important).toBe(true);
    expect(desk.screenPixels).toBe(0);
    expect(desk.repair).toBe('Inspect framing or occlusion for this instance.');
    // Vedlejší objekt zakrytí ani velikost nehlásí — byl by to šum.
    expect(report[1].instances[0]).toMatchObject({ important: false, occlusion: null, screenPixels: null });
    // **Hrdina na vedlejším požadavku je důležitý taky.** Kdyby důležitost
    // visela jen na `priority: main`, hlavní předmět věty, který planner
    // zařadil pod vedlejší požadavek, by o zakrytí i velikost tiše přišel.
    // A zakrytí je skutečný počet, ne nula: tři z pěti paprsků do hodin
    // narazily do něčeho jiného.
    expect(report[2].instances[0]).toMatchObject({
      important: true, screenPixels: 120, occlusion: { samples: 5, occluded: 3 },
    });
  });

  it('fixture 2: pět židlí nezakryje pět chybějících lidí', () => {
    const people = Array.from({ length: 5 }, (_, i) => `person${i}`);
    const chairs = Array.from({ length: 5 }, (_, i) => `chair${i}`);
    const provenance = { kind: 'requested', quote: 'five people on five chairs' } as const;
    const spec = {
      version: 1,
      requirements: [
        { id: 'people', description: 'five people', priority: 'main', polarity: 'required', count: 5, instanceIds: people, provenance },
        { id: 'chairs', description: 'five chairs', priority: 'secondary', polarity: 'required', count: 5, instanceIds: chairs, provenance },
      ],
      instances: [...people, ...chairs].map((stableId) => ({ stableId, role: people.includes(stableId) ? 'hero' : 'prop',
        requirementIds: [people.includes(stableId) ? 'people' : 'chairs'], provenance, attributes: [],
        orientation: { description: 'facing the stage', provenance } })),
      relations: [], clarifications: [],
    } as unknown as SceneSpec;
    const report = visibilityReport(spec, chairs.map((id) => seen(id, { screenPixels: 10 })), [], {},
      chairs.map((id) => contactOf(id)));
    expect(report[0].instances.map((i) => i.status)).toEqual(Array(5).fill('planned'));
    // Židle jsou načtené, ale 10 px je pod čitelnou mezí — to není důkaz, že
    // je někdo uvidí.
    expect(report[1].instances.map((i) => i.status)).toEqual(Array(5).fill('loaded'));
    // Chybějící člověk nemá kontakt: nemá kusy, které by se čeho držely.
    expect(report[0].instances.every((i) => i.contact === null)).toBe(true);
    expect(report[1].instances.every((i) => i.contact?.instances === 1)).toBe(true);
  });

  it('fixture 3: plán opomenul akvárium — nezávislé očekávání ho najde', () => {
    const report = visibilityReport(room(), [seen('desk'), seen('lamp')],
      [{ description: 'an aquarium from the original sentence', instanceIds: ['aquarium'] }]);
    const aquarium = report[3].instances[0];
    expect(aquarium.status).toBe('absent');
    expect(aquarium.repair).toBe('Restore the omitted requirement in the semantic plan.');
    expect(aquarium.contact).toBeNull();
  });

  it('fixture 4: objekt vypadá jinak — a druhé selhání se vykáže, nespustí další kolo', () => {
    const observations = [seen('desk'), seen('lamp')];
    const first = visibilityReport(room(), observations, [], { desk: false }, [contactOf('desk')]);
    expect(first[0].instances[0]).toMatchObject({
      status: 'visible', recognition: false,
      repair: 'Revise this representation; its identity was not recognized.',
      repairRounds: 0, reported: null,
    });
    // Zakrytí se u důležitého objektu hlásí i když je vidět celý: nula
    // zakrytých vzorků je odpověď, ne mlčení.
    expect(first[0].instances[0].occlusion).toEqual({ samples: 5, occluded: 0 });

    const second = visibilityReport(room(), observations, [], { desk: false }, [contactOf('desk')], { desk: 1 });
    expect(second[0].instances[0]).toMatchObject({
      repairRounds: 1, repair: null,
      reported: 'One targeted repair round already ran; the instance is still visible.',
    });

    // Kolo, po kterém se objekt doopravdy spravil, se nevykazuje jako selhání.
    const solved = visibilityReport(room(), observations, [], { desk: true }, [contactOf('desk')], { desk: 1 });
    expect(solved[0].instances[0]).toMatchObject({ status: 'recognizable', repair: null, reported: null });
  });
});
