/** Fixed fixture sequence crossing the current sixteen-entry client LRU. */
import { createHash } from 'node:crypto';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import surface from '../evals/reality-compiler/museum.sim.json';

export const ORDINARY_MEMORY_SEQUENCE = Object.freeze([...Array.from({ length: 16 }, (_, i) => i + 1), 0, 16]);
export function ordinaryMemoryFixture(variant: number) {
  if (!Number.isInteger(variant) || variant < 0 || variant > 16) throw new Error('FIXED_VARIANT_REQUIRED');
  const sim = structuredClone(surface);
  Object.entries(sim.rules).forEach(([id, rule]) => Object.assign(rule, { id }));
  const base = structuredClone(EXAMPLE_BLUEPRINT_ANSWER.shapes[0]);
  const shape = { ...base, shapeId: 'visitor-shape', stableId: 'visitor',
    nodes: base.nodes.map((node, index) => index === 0 ? { ...node, radius: 0.30 + variant / 100 } : node) };
  return blueprintSchema.parse({ version: 'worldstream-v1', sessionSeed: 4021,
    title: 'Ordinary cache eviction fixture', intent: EXAMPLE_PLAN.intent,
    geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [shape],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'shape', shapeId: 'visitor-shape' }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } }] });
}
export function ordinaryMemoryFixtureHashes() {
  return Array.from({ length: 17 }, (_, variant) => ({ variant,
    sha256: createHash('sha256').update(JSON.stringify(ordinaryMemoryFixture(variant))).digest('hex') }));
}
export interface OrdinaryMemorySample {
  edit: number; variant: number; workerJobs: number; representationId: string | null;
  memory: { geometries: number; textures: number; programs: number };
  mesh: { outcome: string; provenance: string; elapsedMs: number | null };
  frame: { outcome: string; elapsedMs: number | null } | null;
}
export function validateOrdinaryMemorySamples(initialWorkerJobs: number, samples: readonly OrdinaryMemorySample[]) {
  const checks = { initialWorkerObserved: Number.isSafeInteger(initialWorkerJobs) && initialWorkerJobs > 0,
    completeSequence: samples.length === 18 && samples.every((s, i) => s.edit === i + 1 && s.variant === ORDINARY_MEMORY_SEQUENCE[i]),
    freshAndEvictedProgramsMesh: samples.length >= 17 && samples.slice(0, 17).every((s, i) => s.workerJobs === initialWorkerJobs + i + 1 && s.mesh.provenance !== 'cache'),
    recentProgramHitsCache: samples.length === 18 && samples[17].workerJobs === samples[16].workerJobs && samples[17].mesh.provenance === 'cache',
    completedMeshAndFrames: samples.length > 0 && samples.every(s => s.mesh.outcome === 'completed' && s.mesh.elapsedMs !== null && Number.isFinite(s.mesh.elapsedMs) && s.mesh.elapsedMs >= 0
      && s.frame?.outcome === 'completed' && s.frame.elapsedMs !== null && Number.isFinite(s.frame.elapsedMs) && s.frame.elapsedMs >= 0),
    newRepresentationPerCommit: samples.length > 0 && samples.every((s, i) => s.representationId !== null && (i === 0 || s.representationId !== samples[i - 1].representationId)),
    stableRendererCounts: samples.length > 0 && samples[0].memory.geometries > 0 && samples[0].memory.programs > 0 && samples.every(s =>
      s.memory.geometries === samples[0].memory.geometries && s.memory.textures === samples[0].memory.textures && s.memory.programs === samples[0].memory.programs) };
  return { status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', checks };
}
