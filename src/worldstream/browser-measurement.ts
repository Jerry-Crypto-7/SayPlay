import type { ProjectRevision } from './evidence-commit';
import type { RuntimeController, RuntimeSnapshot } from './runtime-controller';
import type { RuntimeAction } from './runtime-input';
import type { TraceInput } from '../sim/interpreter';

export interface SourceObservation {
  project: ProjectRevision;
  runtime: RuntimeSnapshot;
  actions: readonly RuntimeAction[];
  inputs: readonly TraceInput[];
  generation: 'live' | 'fixture';
}
declare global {
  interface Window {
    __realityCompiler?: { snapshot(): SourceObservation | null };
  }
}
/** Stejná pouze čtecí diagnostika jako __worldstreamStage. Žádné vstupy ani autorita ke commitu. */
export function sourceObservation(project: ProjectRevision | null, runtime: RuntimeController | null,
  generation: SourceObservation['generation']): SourceObservation | null {
  return project && runtime ? structuredClone({ project, runtime: runtime.getSnapshot(),
    actions: runtime.actions, inputs: runtime.getInputLog(), generation }) : null;
}
