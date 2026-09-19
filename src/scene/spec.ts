import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
export const provenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requested'), quote: text }).strict(),
  z.object({ kind: z.literal('inferred'), reason: text }).strict(),
]);
export const SCENE_RELATIONS = ['inside', 'on', 'against', 'near', 'facing', 'connected-to'] as const;
const INSTANCE_ROLES = ['architecture', 'hero', 'prop', 'terrain', 'effect'] as const;
const requirementSchema = z.object({
  id, description: text, priority: z.enum(['main', 'secondary']),
  polarity: z.enum(['required', 'forbidden']),
  count: z.number().int().min(0).max(200),
  instanceIds: z.array(id).max(200), provenance: provenanceSchema,
}).strict();
const orientationSchema = z.object({ description: text, provenance: provenanceSchema }).strict();
const relationSchema = z.object({
  subjectId: id, relation: z.enum(SCENE_RELATIONS), targetId: id,
  provenance: provenanceSchema,
}).strict();
const clarificationSchema = z.object({
  question: text, affects: z.enum(['appearance', 'interaction']),
  assumption: text,
}).strict();
export const sceneSpecSchema = z.object({
  version: z.literal(1),
  requirements: z.array(requirementSchema).min(1).max(200),
  instances: z.array(z.object({
    stableId: id, requirementIds: z.array(id).min(1).max(200),
    role: z.enum(INSTANCE_ROLES),
    provenance: provenanceSchema,
    attributes: z.array(z.object({ name: text, value: text, provenance: provenanceSchema }).strict()).max(40),
    orientation: orientationSchema,
  }).strict()).min(1).max(200),
  relations: z.array(relationSchema).max(600),
  clarifications: z.array(clarificationSchema).max(12),
}).strict();

/**
 * Slova orientace štíhlého tvaru v2 (P22 T5). `none` čte čtenář stejně jako
 * vynechanou orientaci; ostatní čtyři jsou světové strany, tak jak je zná
 * geometrie (`src/geom/program.ts` má `north`/`south` u otvorů).
 */
export const ORIENTATION_WORDS = ['n', 'e', 's', 'w', 'none'] as const;
type OrientationWord = (typeof ORIENTATION_WORDS)[number];
const COMPASS: Record<Exclude<OrientationWord, 'none'>, string> = { n: 'north', e: 'east', s: 'south', w: 'west' };

/** Index do `requirements`, kterým relace, instance a atributy ve v2 odkazují na původ místo opsaného citátu. */
const requirementIndex = z.number().int().min(0).max(199);

/**
 * **Štíhlý tvar, který plánovač píše od P21 T18 a v2 od P22 T5** — a zároveň
 * nadmnožina plného.
 *
 * Naměřeno 19. 9. 2026 (`evals/worldstream/planner-anatomy.json`): odpověď
 * plánovače má 6,8 kB a 31 % z toho jsou `provenance` objekty rozsypané
 * u instancí, atributů a orientací, které jen opakují původ požadavku.
 * Tady je proto všechno, co čtenář umí odvodit, volitelné: `requirementIds`
 * (z `requirements[].instanceIds`), původ instance (z jejího prvního
 * požadavku), původ atributu (z instance) a orientace (výchozí podle role).
 *
 * **V2** jde o krok dál tam, kde T18 nic odvodit neuměl: po T18 zbylo
 * 1 138 B relací (každá s opsaným citátem), 999 B orientací volným textem
 * a 820 B atributů, z nichž orákulum čte jen `color`, `material` a `state`.
 * Původ se proto smí zapsat indexem `req` do `requirements` — u relace,
 * instance i atributu — orientace je jedno ze slov `n|e|s|w|none`
 * a `attributes` se smí vynechat. Plný tvar z archivu tímhle schématem
 * projde beze změny.
 */
export const slimSceneSpecSchema = z.object({
  version: z.literal(1),
  requirements: z.array(requirementSchema).min(1).max(200),
  instances: z.array(z.object({
    stableId: id, requirementIds: z.array(id).min(1).max(200).optional(),
    role: z.enum(INSTANCE_ROLES),
    provenance: provenanceSchema.optional(), req: requirementIndex.optional(),
    attributes: z.array(z.object({ name: text, value: text, provenance: provenanceSchema.optional(), req: requirementIndex.optional() }).strict()).max(40).optional(),
    orientation: z.union([orientationSchema, z.enum(ORIENTATION_WORDS)]).optional(),
  }).strict()).min(1).max(200),
  relations: z.array(z.object({
    subjectId: id, relation: z.enum(SCENE_RELATIONS), targetId: id,
    provenance: provenanceSchema.optional(), req: requirementIndex.optional(),
  }).strict()).max(600),
  clarifications: z.array(clarificationSchema).max(12),
}).strict();

export type SceneSpec = z.infer<typeof sceneSpecSchema>;
export type SlimSceneSpec = z.infer<typeof slimSceneSpecSchema>;
export type SemanticProvenance = z.infer<typeof provenanceSchema>;

type Instance = SceneSpec['instances'][number];
type Orientation = Instance['orientation'];

const DEFAULT_ORIENTATION_DESCRIPTION = 'No orientation stated; the composition decides its facing.';

/** Orientace, kterou čtenář dosadí instanci bez orientace. Nic ji nečte, ale plný tvar ji nese. */
function defaultOrientation(role: Instance['role']): Orientation {
  return { description: DEFAULT_ORIENTATION_DESCRIPTION, provenance: { kind: 'inferred', reason: `the sentence gives no orientation for this ${role}` } };
}

/**
 * Orientace, na kterou se rozbalí slovo. Původ je `inferred`, protože slovo
 * žádný citát nenese a `requested` bez citátu schéma nezná; compiler dostává
 * plný tvar v `canonical(plan)`, takže věta „Faces north." je to, co čte.
 */
function wordOrientation(word: Exclude<OrientationWord, 'none'>, role: Instance['role']): Orientation {
  return { description: `Faces ${COMPASS[word]}.`, provenance: { kind: 'inferred', reason: `the planner stated the facing as a compass word for this ${role}` } };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Štíhlý tvar doplněný na plný, nebo věta o tom, co chybí. Bezztrátové v obou
 * směrech: plný vstup se nemění, štíhlý dostane přesně to, co `slimSceneSpec`
 * nebo `slimSceneSpecV2` odebraly.
 *
 * Relace bez `req` i bez `provenance` je chyba se jménem relace, ne tiché
 * zahození: schéma by prošlo a compiler by o relaci přišel, aniž by to kdo
 * viděl (`__tests__/spec.test.ts`, v2).
 */
function inflate(slim: SlimSceneSpec): SceneSpec | string {
  const requirements = new Map(slim.requirements.map((entry) => [entry.id, entry]));
  const byIndex = (req: number, where: string): SemanticProvenance | string =>
    req < slim.requirements.length ? slim.requirements[req].provenance : `sceneSpec: ${where} points at requirement ${String(req)} of ${String(slim.requirements.length)}`;
  const instances: Instance[] = [];
  for (const instance of slim.instances) {
    const requirementIds = instance.requirementIds
      ?? slim.requirements.filter((entry) => entry.instanceIds.includes(instance.stableId)).map((entry) => entry.id);
    if (requirementIds.length === 0) return `sceneSpec: instance ${instance.stableId} belongs to no requirement`;
    const provenance = instance.provenance
      ?? (instance.req === undefined ? requirements.get(requirementIds[0])?.provenance : byIndex(instance.req, `instance ${instance.stableId}`));
    if (provenance === undefined) return `sceneSpec: broken instance reference ${instance.stableId}/${requirementIds[0]}`;
    if (typeof provenance === 'string') return provenance;
    const attributes: Instance['attributes'] = [];
    for (const { req, provenance: own, ...attribute } of instance.attributes ?? []) {
      const origin = own ?? (req === undefined ? provenance : byIndex(req, `attribute ${instance.stableId}.${attribute.name}`));
      if (typeof origin === 'string') return origin;
      attributes.push({ ...attribute, provenance: origin });
    }
    const { orientation } = instance;
    instances.push({
      stableId: instance.stableId,
      requirementIds,
      role: instance.role,
      provenance,
      attributes,
      orientation: orientation === undefined || orientation === 'none' ? defaultOrientation(instance.role)
        : typeof orientation === 'string' ? wordOrientation(orientation, instance.role) : orientation,
    });
  }
  const relations: SceneSpec['relations'] = [];
  for (const { req, provenance: own, ...relation } of slim.relations) {
    const key = `${relation.subjectId}/${relation.relation}/${relation.targetId}`;
    const provenance = own ?? (req === undefined ? `sceneSpec: relation ${key} has neither req nor provenance` : byIndex(req, `relation ${key}`));
    if (typeof provenance === 'string') return provenance;
    relations.push({ ...relation, provenance });
  }
  return { ...slim, instances, relations };
}

/**
 * Plný tvar bez toho, co čtenář doplní zpět. **Odebírá jen, co se vrátí
 * beze změny** — původ, který se od zděděného liší, nebo `requirementIds`
 * v jiném pořadí, než v jakém stojí požadavky, zůstávají; round-trip nad
 * archivem (`__tests__/spec.test.ts`) je celý smysl téhle záruky.
 */
export function slimSceneSpec(spec: SceneSpec): SlimSceneSpec {
  const requirements = new Map(spec.requirements.map((entry) => [entry.id, entry]));
  return {
    ...spec,
    instances: spec.instances.map((instance) => {
      const derivedIds = spec.requirements.filter((entry) => entry.instanceIds.includes(instance.stableId)).map((entry) => entry.id);
      const inherited = requirements.get(instance.requirementIds[0])?.provenance;
      const { requirementIds, provenance, orientation, attributes, ...rest } = instance;
      return {
        ...rest,
        ...(same(requirementIds, derivedIds) ? {} : { requirementIds }),
        ...(same(provenance, inherited) ? {} : { provenance }),
        attributes: attributes.map((attribute) => {
          const { provenance: own, ...attributeRest } = attribute;
          return same(own, provenance) ? attributeRest : attribute;
        }),
        ...(same(orientation, defaultOrientation(instance.role)) ? {} : { orientation }),
      };
    }),
  };
}

/**
 * Plný tvar zapsaný jako v2, bezztrátově. Nad `slimSceneSpec` navíc: původ,
 * který se shoduje s některým požadavkem, se zapíše indexem `req`; orientace,
 * která je přesně rozbalením slova, se zapíše slovem; prázdné `attributes`
 * se vynechají. Co se s ničím neshoduje, zůstane vypsané — archiv z 17. 9.
 * má orientace volným textem, a ten se tudy nezkracuje. **Odhad toho, co
 * model napíše podle zadání v2, dělá `asPromptedV2` v `planner-anatomy.measure.ts`.**
 */
export function slimSceneSpecV2(spec: SceneSpec): SlimSceneSpec {
  const requirements = new Map(spec.requirements.map((entry) => [entry.id, entry]));
  const byProvenance = (provenance: SemanticProvenance): number => spec.requirements.findIndex((entry) => same(entry.provenance, provenance));
  const reference = (provenance: SemanticProvenance) => {
    const req = byProvenance(provenance);
    return req === -1 ? { provenance } : { req };
  };
  return {
    ...spec,
    instances: spec.instances.map((instance) => {
      const derivedIds = spec.requirements.filter((entry) => entry.instanceIds.includes(instance.stableId)).map((entry) => entry.id);
      const inherited = requirements.get(instance.requirementIds[0])?.provenance;
      const { requirementIds, provenance, orientation, attributes, ...rest } = instance;
      const word = (['n', 'e', 's', 'w'] as const).find((entry) => same(orientation, wordOrientation(entry, instance.role)));
      return {
        ...rest,
        ...(same(requirementIds, derivedIds) ? {} : { requirementIds }),
        ...(same(provenance, inherited) ? {} : reference(provenance)),
        ...(attributes.length === 0 ? {} : {
          attributes: attributes.map(({ provenance: own, ...attribute }) => ({ ...attribute, ...(same(own, provenance) ? {} : reference(own)) })),
        }),
        ...(same(orientation, defaultOrientation(instance.role)) ? {} : word === undefined ? { orientation } : { orientation: word }),
      };
    }),
    relations: spec.relations.map(({ provenance, ...relation }) => ({ ...relation, ...reference(provenance) })),
  };
}

/**
 * Chyby schématu jako jedna věta. Orientace je od v2 `union` objektu a slova
 * a zod za ni hlásí jen „Invalid input" na cestě `orientation`; větve se
 * proto rozbalí, aby chyběl-li `provenance`, hláška ho pojmenovala
 * (`instances.0.orientation.provenance`), jak to od T18 čeká sebeoprava i test.
 */
function issuesText(issues: readonly z.core.$ZodIssue[], parent: readonly PropertyKey[] = []): string {
  return issues.map((issue) => {
    const path = [...parent, ...issue.path];
    if (issue.code === 'invalid_union') return issue.errors.map((branch) => issuesText(branch, path)).join('; ');
    return `${path.join('.')}: ${issue.message}`;
  }).join('; ');
}

/** Structural and referential validation; does not claim that an image fulfils a prompt. */
export function readSceneSpec(value: unknown, objectIds?: readonly string[], prompt?: string): SceneSpec | string {
  const slim = slimSceneSpecSchema.safeParse(value);
  if (!slim.success) return `sceneSpec: ${issuesText(slim.error.issues)}`;
  const inflated = inflate(slim.data);
  if (typeof inflated === 'string') return inflated;
  const parsed = sceneSpecSchema.safeParse(inflated);
  if (!parsed.success) return `sceneSpec: ${issuesText(parsed.error.issues)}`;
  const spec = parsed.data;
  const instances = new Map(spec.instances.map((entry) => [entry.stableId, entry]));
  const requirements = new Map(spec.requirements.map((entry) => [entry.id, entry]));
  if (instances.size !== spec.instances.length) return 'sceneSpec: duplicate instance stableId';
  if (requirements.size !== spec.requirements.length) return 'sceneSpec: duplicate requirement id';
  if (objectIds && (new Set(objectIds).size !== objectIds.length || objectIds.length !== instances.size || objectIds.some((entry) => !instances.has(entry))))
    return 'sceneSpec: instances must exactly match planned object IDs';
  for (const req of spec.requirements) {
    if (new Set(req.instanceIds).size !== req.instanceIds.length) return `sceneSpec: duplicate instance in ${req.id}`;
    if (req.polarity === 'forbidden' && (req.count !== 0 || req.instanceIds.length !== 0)) return `sceneSpec: forbidden requirement ${req.id} must have zero instances`;
    if (req.polarity === 'required' && (req.count < 1 || req.count !== req.instanceIds.length)) return `sceneSpec: exact count mismatch for ${req.id}`;
    for (const instanceId of req.instanceIds) {
      const instance = instances.get(instanceId);
      if (!instance || !instance.requirementIds.includes(req.id)) return `sceneSpec: broken requirement reference ${req.id}/${instanceId}`;
    }
  }
  for (const instance of spec.instances) {
    if (new Set(instance.requirementIds).size !== instance.requirementIds.length) return `sceneSpec: duplicate requirement in ${instance.stableId}`;
    for (const requirementId of instance.requirementIds) {
      const requirement = requirements.get(requirementId);
      if (!requirement || !requirement.instanceIds.includes(instance.stableId)) return `sceneSpec: broken instance reference ${instance.stableId}/${requirementId}`;
    }
  }
  const relations = new Set<string>();
  for (const relation of spec.relations) {
    if (!instances.has(relation.subjectId) || !instances.has(relation.targetId)) return 'sceneSpec: relation references missing instance';
    if (relation.subjectId === relation.targetId) return 'sceneSpec: self relation';
    const key = `${relation.subjectId}/${relation.relation}/${relation.targetId}`;
    if (relations.has(key)) return 'sceneSpec: duplicate relation';
    relations.add(key);
  }
  if (prompt !== undefined) {
    const sources: SemanticProvenance[] = [
      ...spec.requirements.map((r) => r.provenance),
      ...spec.instances.flatMap((i) => [i.provenance, i.orientation.provenance, ...i.attributes.map((a) => a.provenance)]),
      ...spec.relations.map((r) => r.provenance),
    ];
    for (const source of sources)
      if (source.kind === 'requested' && !prompt.includes(source.quote)) return `sceneSpec: requested quote is absent from prompt: ${source.quote}`;
  }
  return spec;
}
