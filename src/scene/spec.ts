import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
export const provenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requested'), quote: text }).strict(),
  z.object({ kind: z.literal('inferred'), reason: text }).strict(),
]);
export const SCENE_RELATIONS = ['inside', 'on', 'against', 'near', 'facing', 'connected-to'] as const;
export const sceneSpecSchema = z.object({
  version: z.literal(1),
  requirements: z.array(z.object({
    id, description: text, priority: z.enum(['main', 'secondary']),
    polarity: z.enum(['required', 'forbidden']),
    count: z.number().int().min(0).max(200),
    instanceIds: z.array(id).max(200), provenance: provenanceSchema,
  }).strict()).min(1).max(200),
  instances: z.array(z.object({
    stableId: id, requirementIds: z.array(id).min(1).max(200),
    role: z.enum(['architecture', 'hero', 'prop', 'terrain', 'effect']),
    provenance: provenanceSchema,
    attributes: z.array(z.object({ name: text, value: text, provenance: provenanceSchema }).strict()).max(40),
    orientation: z.object({ description: text, provenance: provenanceSchema }).strict(),
  }).strict()).min(1).max(200),
  relations: z.array(z.object({
    subjectId: id, relation: z.enum(SCENE_RELATIONS), targetId: id,
    provenance: provenanceSchema,
  }).strict()).max(600),
  clarifications: z.array(z.object({
    question: text, affects: z.enum(['appearance', 'interaction']),
    assumption: text,
  }).strict()).max(12),
}).strict();

export type SceneSpec = z.infer<typeof sceneSpecSchema>;
export type SemanticProvenance = z.infer<typeof provenanceSchema>;

/** Structural and referential validation; does not claim that an image fulfils a prompt. */
export function readSceneSpec(value: unknown, objectIds?: readonly string[], prompt?: string): SceneSpec | string {
  const parsed = sceneSpecSchema.safeParse(value);
  if (!parsed.success) return `sceneSpec: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
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
