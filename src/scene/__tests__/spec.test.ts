/**
 * **Štíhlý `sceneSpec` (P21 T18): co plánovač nemusí psát a čtenář doplní.**
 *
 * Naměřeno 19. 9. 2026 (`evals/worldstream/planner-anatomy.json`): odpověď
 * plánovače má 6,8 kB, z toho 79 % `sceneSpec`, a uvnitř 31 % celku jsou
 * rozsypané `provenance` objekty u instancí, atributů a orientací —
 * informace, kterou požadavek už nese. Čtenář proto přijme **oba** tvary:
 * plný z archivu beze změny, a štíhlý, kde instance dědí původ z požadavku,
 * `requirementIds` se odvodí z `requirements[].instanceIds` a chybějící
 * orientace se čte jako `inferred` podle role.
 *
 * Dvě vlastnosti, které oko nepokryje, a proto se tu soudí:
 *
 * 1. **Doplnění je bezztrátové.** Plný plán z archivu → `slimSceneSpec()` →
 *    `readSceneSpec()` musí dát **týž** `SceneSpec`. Kdyby čtenář
 *    `requirementIds` nedoplnil, nebo kdyby zeštíhlení zahodilo původ
 *    požadavku, round-trip nad 18 archivovanými plány zčervená.
 * 2. **Plný tvar se nemění.** Všechno, co čte `plan.sceneSpec` z archivu
 *    (`replay-create`, `massing-preview`), dostane přesně to, co dřív.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSceneSpec, slimSceneSpec, slimSceneSpecV2, type SceneSpec } from '../spec';

const ARCHIVE = fileURLToPath(new URL('../../../plans/P20/t18-hybrid-v2-20260917-1803/raw', import.meta.url));
const archived = existsSync(ARCHIVE)
  ? readdirSync(ARCHIVE)
      .filter((name) => name.endsWith('-planner.json'))
      .sort()
      .map((file) => ({
        id: file.replace('-planner.json', ''),
        value: (JSON.parse(readFileSync(`${ARCHIVE}/${file}`, 'utf8')) as { value: { sceneSpec: unknown } }).value,
      }))
  : [];

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const requested = (quote: string) => ({ kind: 'requested' as const, quote });
const inferred = (reason: string) => ({ kind: 'inferred' as const, reason });

/** Plný tvar, jak ho plánovač psal do 19. 9. 2026. */
function full(): SceneSpec {
  return {
    version: 1,
    requirements: [
      { id: 'towerReq', description: 'one tower', priority: 'main', polarity: 'required', count: 1, instanceIds: ['tower'], provenance: requested('a tower') },
      { id: 'lampReq', description: 'two lamps', priority: 'secondary', polarity: 'required', count: 2, instanceIds: ['lampA', 'lampB'], provenance: requested('two lamps') },
    ],
    instances: [
      { stableId: 'tower', requirementIds: ['towerReq'], role: 'architecture', provenance: requested('a tower'), attributes: [{ name: 'material', value: 'stone', provenance: requested('a tower') }], orientation: { description: 'faces the road', provenance: requested('facing the road') } },
      { stableId: 'lampA', requirementIds: ['lampReq'], role: 'prop', provenance: requested('two lamps'), attributes: [], orientation: { description: 'No orientation stated; the composition decides its facing.', provenance: inferred('the sentence gives no orientation for this prop') } },
      { stableId: 'lampB', requirementIds: ['lampReq'], role: 'prop', provenance: inferred('the second of the two lamps'), attributes: [{ name: 'colour', value: 'brass', provenance: inferred('lamps in this setting are brass') }], orientation: { description: 'No orientation stated; the composition decides its facing.', provenance: inferred('the sentence gives no orientation for this prop') } },
    ],
    relations: [{ subjectId: 'lampA', relation: 'near', targetId: 'tower', provenance: inferred('lamps stand by the tower') }],
    clarifications: [],
  };
}

describe('štíhlý tvar se doplní na plný', () => {
  it('instance bez requirementIds, původu a orientace dostane všechno z požadavku a z role', () => {
    const slim = {
      version: 1,
      requirements: full().requirements,
      instances: [
        { stableId: 'tower', role: 'architecture', attributes: [{ name: 'material', value: 'stone' }], orientation: { description: 'faces the road', provenance: requested('facing the road') } },
        { stableId: 'lampA', role: 'prop', attributes: [] },
        { stableId: 'lampB', role: 'prop', attributes: [{ name: 'colour', value: 'brass' }] },
      ],
      relations: full().relations,
      clarifications: [],
    };
    const read = readSceneSpec(slim);
    expect(typeof read).not.toBe('string');
    if (typeof read === 'string') return;
    expect(read.instances[0]).toEqual({ ...full().instances[0] });
    expect(read.instances[1]).toEqual({ ...full().instances[1] });
    // lampB dědí původ požadavku (ne ten „inferred" z plného tvaru) a atribut dědí původ instance.
    expect(read.instances[2]).toEqual({
      ...full().instances[2],
      provenance: requested('two lamps'),
      attributes: [{ name: 'colour', value: 'brass', provenance: requested('two lamps') }],
    });
    expect(read.requirements).toEqual(full().requirements);
  });

  it('orientace, když už se píše, nese původ — bez něj je to schéma chyba, ne tichý default', () => {
    const slim = { ...full(), instances: [{ stableId: 'tower', role: 'architecture', attributes: [], orientation: { description: 'faces the road' } }, { stableId: 'lampA', role: 'prop', attributes: [] }, { stableId: 'lampB', role: 'prop', attributes: [] }] };
    expect(readSceneSpec(slim)).toContain('instances.0.orientation.provenance');
  });

  it('instance, kterou žádný požadavek nejmenuje, se odmítne jménem, ne obecnou schéma chybou', () => {
    const slim = { ...full(), instances: [...full().instances.map(({ requirementIds: _ids, ...rest }) => rest), { stableId: 'ghost', role: 'prop', attributes: [] }] };
    expect(readSceneSpec(slim)).toBe('sceneSpec: instance ghost belongs to no requirement');
  });

  it('plný tvar projde beze změny a citace se dál kontrolují proti větě', () => {
    expect(readSceneSpec(full())).toEqual(full());
    expect(readSceneSpec(full(), ['tower', 'lampA', 'lampB'], 'a tower facing the road, two lamps')).toEqual(full());
    expect(readSceneSpec(full(), undefined, 'a tower, two lamps')).toContain('requested quote is absent');
  });
});

describe('slimSceneSpec je bezztrátové zeštíhlení', () => {
  it('na ručním plánu shodí jen to, co čtenář doplní zpět', () => {
    const slim = slimSceneSpec(full());
    expect(readSceneSpec(slim)).toEqual(full());
    expect(bytes(slim)).toBeLessThan(bytes(full()));
    const instances = slim.instances as readonly Record<string, unknown>[];
    for (const instance of instances) expect(instance).not.toHaveProperty('requirementIds');
    // tower: původ shodný s požadavkem → chybí; orientace citovaná → zůstává.
    expect(instances[0]).not.toHaveProperty('provenance');
    expect(instances[0]).toHaveProperty('orientation');
    // lampA: výchozí orientace → chybí.
    expect(instances[1]).not.toHaveProperty('orientation');
    // lampB: původ jiný než u požadavku → zůstává, aby round-trip držel.
    expect(instances[2]).toHaveProperty('provenance', inferred('the second of the two lamps'));
  });

  it('requirementIds zůstanou, když jejich pořadí neodpovídá pořadí požadavků', () => {
    const swapped = { ...full(), requirements: [full().requirements[1], full().requirements[0]] };
    const slim = slimSceneSpec(swapped as SceneSpec);
    expect(readSceneSpec(slim)).toEqual(swapped);
  });

  it.skipIf(archived.length === 0)('18 plných plánů z archivu projde round-tripem beze změny', () => {
    expect(archived).toHaveLength(18);
    for (const { id, value } of archived) {
      const fullRead = readSceneSpec(value.sceneSpec);
      if (typeof fullRead === 'string') throw new Error(`${id}: ${fullRead}`);
      expect(fullRead, `${id}: plný tvar se změnil`).toEqual(value.sceneSpec);
      const slim = slimSceneSpec(fullRead);
      expect(readSceneSpec(slim), `${id}: round-trip`).toEqual(fullRead);
      expect(bytes(slim), id).toBeLessThanOrEqual(bytes(fullRead));
    }
  });
});

/**
 * **Štíhlý tvar v2 (P22 T5): citace jednou, zbytek odkazem.**
 *
 * Po T18 zůstalo v odpovědi to, co čtenář neuměl odvodit: původ relací (každá
 * relace opakovala citát požadavku), volný text orientace u každé instance
 * a atributy, které žádné orákulum nečte. V2 proto (1) nechává `provenance`
 * jen v `requirements[i]` a relace, instance i atributy na něj ukazují
 * indexem `req`, (2) píše orientaci jako jedno ze slov `n|e|s|w|none`,
 * (3) `attributes` vynechává, když instance žádný nemá.
 *
 * Vlastnost, kterou oko nepokryje: čtenář, který relaci bez `req` tiše
 * zahodí, projde schématem a compiler o tu relaci přijde. Proto se soudí
 * **hluboká rovnost** `SceneSpec` přečteného z v2 a ze starého tvaru — ne jen
 * to, že čtení prošlo.
 */
describe('štíhlý tvar v2 dá týž SceneSpec jako starý tvar', () => {
  /** Plný tvar, ve kterém relace, instance i atribut sdílejí citát s požadavkem. */
  function fullV2(): SceneSpec {
    const base = full();
    return {
      ...base,
      instances: [
        { ...base.instances[0], orientation: { description: 'Faces north.', provenance: inferred('the planner stated the facing as a compass word for this architecture') } },
        base.instances[1],
        { ...base.instances[2], provenance: requested('a tower'), attributes: [{ name: 'colour', value: 'brass', provenance: requested('two lamps') }] },
      ],
      relations: [
        { subjectId: 'lampA', relation: 'near', targetId: 'tower', provenance: requested('two lamps') },
        { subjectId: 'lampB', relation: 'facing', targetId: 'tower', provenance: requested('a tower') },
      ],
    };
  }

  /** Totéž, jak to plánovač píše od T5: bez opakovaných citátů. */
  function v2(): unknown {
    return {
      version: 1,
      requirements: fullV2().requirements,
      instances: [
        { stableId: 'tower', role: 'architecture', attributes: [{ name: 'material', value: 'stone' }], orientation: 'n' },
        { stableId: 'lampA', role: 'prop', orientation: 'none' },
        { stableId: 'lampB', role: 'prop', req: 0, attributes: [{ name: 'colour', value: 'brass', req: 1 }] },
      ],
      relations: [
        { subjectId: 'lampA', relation: 'near', targetId: 'tower', req: 1 },
        { subjectId: 'lampB', relation: 'facing', targetId: 'tower', req: 0 },
      ],
      clarifications: [],
    };
  }

  it('relace s req, orientace slovem a instance bez attributes se přečtou na přesně starý tvar', () => {
    expect(readSceneSpec(fullV2())).toEqual(fullV2());
    expect(readSceneSpec(v2())).toEqual(readSceneSpec(fullV2()));
    const read = readSceneSpec(v2());
    if (typeof read === 'string') throw new Error(read);
    expect(read.relations[1].provenance).toEqual(requested('a tower'));
    expect(read.instances[1].attributes).toEqual([]);
    expect(read.instances[1].orientation).toEqual(full().instances[1].orientation);
  });

  it('relace bez req i bez provenance se odmítne jménem — tiché zahození by compiler připravilo o relaci', () => {
    const spec = v2() as { relations: Record<string, unknown>[] };
    delete spec.relations[0].req;
    expect(readSceneSpec(spec)).toBe('sceneSpec: relation lampA/near/tower has neither req nor provenance');
  });

  it('req mimo rozsah požadavků se odmítne, ne přečte jako undefined', () => {
    const spec = v2() as { relations: Record<string, unknown>[] };
    spec.relations[0].req = 2;
    expect(readSceneSpec(spec)).toBe('sceneSpec: relation lampA/near/tower points at requirement 2 of 2');
  });

  it('orientace mimo n|e|s|w|none se odmítne schématem', () => {
    const spec = v2() as { instances: Record<string, unknown>[] };
    spec.instances[0].orientation = 'up';
    expect(readSceneSpec(spec)).toContain('instances.0.orientation');
  });

  it('slimSceneSpecV2 píše slovo, index a nic navíc, a čtenář to vrátí beze změny', () => {
    const slim = slimSceneSpecV2(fullV2());
    expect(readSceneSpec(slim)).toEqual(fullV2());
    expect(bytes(slim)).toBeLessThan(bytes(slimSceneSpec(fullV2())));
    const instances = slim.instances as readonly Record<string, unknown>[];
    expect(instances[0].orientation).toBe('n');
    expect(instances[1]).not.toHaveProperty('orientation');
    expect(instances[1]).not.toHaveProperty('attributes');
    expect(instances[2]).toEqual({ stableId: 'lampB', role: 'prop', req: 0, attributes: [{ name: 'colour', value: 'brass', req: 1 }] });
    expect(slim.relations).toEqual([
      { subjectId: 'lampA', relation: 'near', targetId: 'tower', req: 1 },
      { subjectId: 'lampB', relation: 'facing', targetId: 'tower', req: 0 },
    ]);
  });

  it('původ, který žádný požadavek nenese, zůstává vypsaný — jinak by se round-trip rozešel', () => {
    const slim = slimSceneSpecV2(full());
    expect(readSceneSpec(slim)).toEqual(full());
    expect(slim.relations[0]).toEqual(full().relations[0]);
  });

  it.skipIf(archived.length === 0)('18 plných plánů z archivu projde round-tripem přes v2 a není větších než v1', () => {
    for (const { id, value } of archived) {
      const fullRead = readSceneSpec(value.sceneSpec);
      if (typeof fullRead === 'string') throw new Error(`${id}: ${fullRead}`);
      const slim = slimSceneSpecV2(fullRead);
      expect(readSceneSpec(slim), `${id}: round-trip v2`).toEqual(fullRead);
      expect(bytes(slim), id).toBeLessThanOrEqual(bytes(slimSceneSpec(fullRead)));
    }
  });
});
