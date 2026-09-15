/** Local source-project save. Persist inputs, then validate and replay on restore.
 * A stored JSON object never becomes an accepted project or runtime directly. */
import { z } from 'zod';
import { buildRuntimeWorld } from '../ir/build';
import { canonical } from '../ir/worlddoc';
import { createEvidenceProject, type ProjectRevision } from './evidence-commit';
import { createRuntimeController, type RuntimeController } from './runtime-controller';
import { MAX_COMPARISON_TICK } from './branch-controller';

export const SOURCE_PROJECT_STORAGE_KEY = 'worldstream.source-project.v1';
export const MAX_PROJECT_BYTES = 2_000_000;
const tick = z.int().min(0).max(MAX_COMPARISON_TICK);
const identifier = z.string().min(1).max(128);
const inputSchema = z.strictObject({ tick, actor: identifier, actionId: identifier, target: identifier.optional() });
const inputsSchema = z.array(inputSchema).max(2_048).refine(inputs => inputs.every((input, index) =>
  index === 0 || input.tick > inputs[index - 1].tick), 'input ticks must be strictly increasing');
const runtimeSchema = z.strictObject({ branchId: z.enum(['origin', 'branch-1']), inputs: inputsSchema,
  observationTick: tick, values: z.record(z.string(), z.number().finite()), tick,
  endedAtTick: tick.nullable(), runState: z.string() });
const saveSchema = z.strictObject({ version: z.literal('source-project-v1'), head: z.unknown(),
  selected: z.enum(['origin', 'branch-1']), generation: z.enum(['live', 'fixture']),
  runtimes: z.array(runtimeSchema).min(1).max(2) });
type SavedRuntime = z.infer<typeof runtimeSchema>;

export interface RestoredSourceProject {
  head: ProjectRevision;
  selected: ProjectRevision;
  generation: 'live' | 'fixture';
  store: ReturnType<typeof createEvidenceProject>;
  runtimes: Map<ProjectRevision, RuntimeController>;
}

export function encodeSourceProject(head: ProjectRevision, selected: ProjectRevision,
  runtimes: ReadonlyMap<ProjectRevision, RuntimeController>, generation: 'live' | 'fixture'): string {
  const projects = head.parent ? [head.parent, head] : [head];
  if (!projects.includes(selected)) throw new Error('The selected branch is not part of this project.');
  const data = saveSchema.parse({ version: 'source-project-v1', head, selected: selected.branchId, generation,
    runtimes: projects.map(project => {
      const runtime = runtimes.get(project);
      if (!runtime) throw new Error('A source branch is unavailable.');
      const state = runtime.getSnapshot();
      return { branchId: project.branchId, inputs: runtime.getInputLog(), observationTick: state.observationTick,
        values: state.values, tick: state.tick, endedAtTick: state.endedAtTick, runState: state.runState };
    }) });
  const text = JSON.stringify(data);
  if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) throw new Error('The source project exceeds the local save limit.');
  return text;
}

function controllerFor(project: ProjectRevision, inputs: z.infer<typeof inputsSchema>): RuntimeController {
  const built = buildRuntimeWorld(project.world.sim);
  if (!built.ok) throw new Error('Saved world cannot run.');
  const runtime = createRuntimeController({ ...built.world, trace: inputs });
  if (inputs.some(input => !runtime.actions.some(action => action.actor === input.actor &&
    action.actionId === input.actionId && action.target === input.target))) throw new Error('Saved input is not declared.');
  return runtime;
}
function verifyReplay(runtime: RuntimeController, saved: SavedRuntime) {
  // Replay the whole known log first, preserving the controller's high-water
  // protection when the saved view was rewound before the last visitor input.
  runtime.observeAt(Math.max(saved.observationTick, (saved.inputs.at(-1)?.tick ?? -1) + 1));
  runtime.observeAt(saved.observationTick);
  const actual = runtime.getSnapshot();
  if (canonical(actual.values) !== canonical(saved.values) || actual.tick !== saved.tick ||
    actual.endedAtTick !== saved.endedAtTick || actual.runState !== saved.runState) throw new Error('Saved replay does not match its state.');
  runtime.setPaused(true);
}

export async function decodeSourceProject(text: string): Promise<RestoredSourceProject> {
  if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) throw new Error('Saved project is too large.');
  const data = saveSchema.parse(JSON.parse(text));
  const raw = data.head as ProjectRevision;
  if (!raw || typeof raw !== 'object') throw new Error('Saved project is missing.');
  const origin = raw.parent ?? raw;
  if (origin.parent !== null || origin.comparison !== null) throw new Error('Unsupported saved history.');
  const store = createEvidenceProject();
  const accepted = await store.commitInitial({ base: null, world: origin.world, sources: origin.sources,
    evidence: origin.evidence, parameterConfirmation: origin.parameterConfirmation });
  if (!accepted.ok || canonical(accepted.value) !== canonical(origin)) throw new Error('Saved source revision is invalid.');
  const root = accepted.value;
  let head = root;
  if (raw.parent) {
    const comparison = raw.comparison;
    const intervention = raw.evidence?.interventions[0];
    if (!comparison || !intervention) throw new Error('Saved intervention is incomplete.');
    const common = controllerFor(root, inputsSchema.parse(comparison.inputLog));
    common.observeAt(comparison.observationTick);
    const changed = await store.commitIntervention({ base: root.projectRevision, ruleId: comparison.ruleId,
      durationTicks: comparison.durationTicks, forkTick: comparison.forkTick,
      observationTick: comparison.observationTick, reason: intervention.reason }, common);
    if (!changed.ok || canonical(changed.value) !== canonical(raw)) throw new Error('Saved branch is invalid.');
    head = changed.value;
  }
  const projects = head.parent ? [root, head] : [root];
  if (data.runtimes.length !== projects.length || new Set(data.runtimes.map(runtime => runtime.branchId)).size !== projects.length)
    throw new Error('Saved runtimes do not match the project.');
  const runtimes = new Map<ProjectRevision, RuntimeController>();
  for (const project of projects) {
    const saved = data.runtimes.find(runtime => runtime.branchId === project.branchId);
    if (!saved) throw new Error('Saved runtime is missing.');
    let runtime: RuntimeController;
    if (project.parent) {
      const base = controllerFor(root, saved.inputs);
      const built = buildRuntimeWorld(project.world.sim);
      if (!built.ok) throw new Error('Saved branch cannot run.');
      const result = base.forkAt(built.world, project.comparison!.forkTick,
        Math.max(saved.observationTick, (saved.inputs.at(-1)?.tick ?? -1) + 1));
      if (result.verdict !== 'REBRANCHED') throw new Error('Saved branch cannot be replayed.');
      runtime = result.controller;
    } else runtime = controllerFor(root, saved.inputs);
    verifyReplay(runtime, saved);
    runtimes.set(project, runtime);
  }
  const selected = projects.find(project => project.branchId === data.selected);
  if (!selected) throw new Error('Saved selection is missing.');
  return { head, selected, runtimes, store, generation: data.generation };
}
