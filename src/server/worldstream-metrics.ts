import { AsyncLocalStorage } from 'node:async_hooks';
import type { PhaseObserver } from '../model/phase-observer';

export interface ServerPhase {
  name: string;
  startedAtMs: number;
  elapsedMs: number | null;
  outcome: 'pending' | 'completed' | 'failed';
}
/** Request-local, bounded diagnostics. No prompts, credentials, model outputs,
 * document hashes, or inferred model-only latency are retained. */
export function createServerMetrics(requestId: string, kind: 'source' | 'prompt' | 'edit', now = () => performance.now()) {
  const started = now();
  const phases: ServerPhase[] = [];
  let droppedPhases = 0;
  let provenance: 'unknown' | 'live' | 'fixture' | 'prepared' = 'unknown';
  const observe: PhaseObserver = name => {
    if (phases.length >= 128) { droppedPhases++; return () => undefined; }
    const at = now();
    const phase: ServerPhase = { name, startedAtMs: Math.max(0, at - started), elapsedMs: null, outcome: 'pending' };
    phases.push(phase);
    return outcome => {
      if (phase.outcome !== 'pending') return;
      phase.elapsedMs = Math.max(0, now() - at);
      phase.outcome = outcome;
    };
  };
  return {
    observe,
    setProvenance(value: typeof provenance) { provenance = value; },
    snapshot() { return { version: 'worldstream-server-v1' as const, requestId, kind, provenance,
      droppedPhases, phases: phases.map(phase => ({ ...phase })) }; },
    header() { return phases.filter(phase => phase.elapsedMs !== null)
      .map((phase, index) => `ws${index};dur=${phase.elapsedMs!.toFixed(3)};desc="${phase.name.replace(/[^a-z0-9-]/g, '')}"`).join(', '); },
  };
}
type Metrics = ReturnType<typeof createServerMetrics>;
const storage = new AsyncLocalStorage<Metrics>();
export const currentServerMetrics = () => storage.getStore();
export const serverPhaseObserver: PhaseObserver = name => storage.getStore()?.observe(name) ?? (() => undefined);

/** HTTP completion is separate from background prompt compilation. Headers only
 * contain phases completed when the response is sent. Background work reports
 * its own final snapshot; the 202 header never claims generation has finished. */
export async function withServerMetrics(requestId: string, kind: 'source' | 'prompt' | 'edit', work: () => Promise<Response>) {
  const metrics = createServerMetrics(requestId, kind);
  return storage.run(metrics, async () => {
    const finish = metrics.observe('http-handler');
    try {
      const response = await work();
      finish(response.ok ? 'completed' : 'failed');
      response.headers.set('Server-Timing', metrics.header());
      response.headers.set('X-Worldstream-Request-Id', requestId);
      return response;
    } catch (error) { finish('failed'); throw error; }
    finally { reportServerMetrics(metrics); }
  });
}

export function reportServerMetrics(metrics: Metrics | undefined) {
  if (!metrics) return;
  try { console.info(JSON.stringify({ event: 'worldstream.server-timing', ...metrics.snapshot() })); }
  catch { /* Telemetry must not change request or slot cleanup behavior. */ }
}
