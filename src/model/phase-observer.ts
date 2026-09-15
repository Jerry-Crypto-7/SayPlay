/** Optional diagnostics, never document/replay state. A completed phase means the
 * operation returned, not that its semantic result was accepted. */
export type PhaseObserver = (name: string) => (outcome: 'completed' | 'failed') => void;

export function beginPhase(observer: PhaseObserver | undefined, name: string) {
  let finish: ReturnType<PhaseObserver> | undefined;
  try { finish = observer?.(name); } catch { /* Diagnostics cannot change behavior. */ }
  return (outcome: 'completed' | 'failed' = 'completed') => {
    try { finish?.(outcome); } catch { /* Diagnostics cannot change behavior. */ }
  };
}

export function observePhase<T>(observer: PhaseObserver | undefined, name: string, work: () => T): T {
  const finish = beginPhase(observer, name);
  try { const result = work(); finish(); return result; }
  catch (error) { finish('failed'); throw error; }
}

export async function observePhaseAsync<T>(observer: PhaseObserver | undefined, name: string, work: () => Promise<T>): Promise<T> {
  const finish = beginPhase(observer, name);
  try { const result = await work(); finish(); return result; }
  catch (error) { finish('failed'); throw error; }
}
