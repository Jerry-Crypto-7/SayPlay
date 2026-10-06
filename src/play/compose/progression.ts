import { z } from 'zod';
import type { ArcadeLevel, BodyInit } from '../arcade/contract';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/);
export const phasesSchema = z.array(z.object({
  start: z.int().min(0).max(999), // permille of a generator's real path length
  speedPercent: z.int().min(75).max(125),
  add: z.array(z.object({ role: z.enum(['collectible', 'obstacle']), count: z.int().min(1).max(3) }).strict()).max(2).optional(),
}).strict()).min(1).max(4).superRefine((phases, context) => {
  if (phases[0]?.start !== 0) context.addIssue({ code: 'custom', message: 'First phase starts at zero' });
  phases.forEach((phase, index) => {
    if (index > 0 && phase.start <= phases[index - 1]!.start) context.addIssue({ code: 'custom', message: 'Phase starts must increase strictly' });
    if (new Set(phase.add?.map(item => item.role)).size !== (phase.add?.length ?? 0)) context.addIssue({ code: 'custom', message: 'Duplicate phase role' });
  });
});
export type Phase = z.infer<typeof phasesSchema>[number];
export const dependsOnSchema = z.array(z.object({ goal: id, action: z.enum(['collect', 'open', 'reach']).optional(), label: z.string().min(1).max(60).optional(), prerequisites: z.array(id).max(7) }).strict()).min(1).max(8).superRefine((nodes, context) => {
  const graph = new Map(nodes.map(node => [node.goal, node.prerequisites]));
  if (graph.size !== nodes.length) context.addIssue({ code: 'custom', message: 'Duplicate goal' });
  for (const node of nodes) if (new Set(node.prerequisites).size !== node.prerequisites.length || node.prerequisites.some(key => !graph.has(key))) context.addIssue({ code: 'custom', message: 'Unknown or repeated prerequisite' });
  const active = new Set<string>(), finished = new Set<string>();
  const visit = (key: string): boolean => {
    if (active.has(key)) return false;
    if (finished.has(key)) return true;
    active.add(key);
    for (const before of graph.get(key) ?? []) if (!visit(before)) return false;
    active.delete(key); finished.add(key); return true;
  };
  if (nodes.some(node => !visit(node.goal))) context.addIssue({ code: 'custom', message: 'Cyclic objective dependencies' });
});
export type Dependency = z.infer<typeof dependsOnSchema>[number];

export function phaseSpeed(base: number, position: number, length: number, phases?: readonly Phase[]): number {
  if (phases === undefined) return base;
  if (length <= 0) throw new Error('Pacing needs a real positive course length');
  const at = Math.max(0, Math.min(999, Math.floor(position * 1000 / length)));
  const phase = [...phases].reverse().find(item => item.start <= at)!;
  return Math.max(1, Math.trunc(base * phase.speedPercent / 100));
}

/** Placement remains owned by each generator: it knows safe lanes and BFS cells. */
export function addPhaseBodies(level: ArcadeLevel, phases: readonly Phase[] | undefined, place: (phase: number, role: 'collectible' | 'obstacle', ordinal: number, from: number, to: number) => BodyInit): ArcadeLevel {
  if (phases === undefined) return level;
  const additions: BodyInit[] = [];
  for (const [index, phase] of phases.entries()) for (const addition of phase.add ?? []) for (let ordinal = 0; ordinal < addition.count; ordinal++) {
    const from = Math.floor(level.length * phase.start / 1000), to = Math.floor(level.length * (phases[index + 1]?.start ?? 1000) / 1000);
    const body = place(index, addition.role, ordinal, from, to);
    if (body.role !== addition.role || body.template || body.z < from || body.z >= to) throw new Error('Phase placement must create a real body in its actual section');
    additions.push(body);
  }
  if (level.bodies.length + additions.length + (level.spawnSlots ?? 0) > 256) throw new Error('Phases exceed body budget');
  return additions.length === 0 ? level : { ...level, bodies: [...level.bodies, ...additions] };
}
