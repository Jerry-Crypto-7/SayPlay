import type { Page } from '@playwright/test';

/** Opt-in renderer observation, outside deterministic simulation/replay. */
export async function measureQualityFrames(page: Page) {
  return page.evaluate(async () => {
    const stage = window.__worldstreamStage;
    if (!stage?.ready()) throw new Error('Frame profile needs a ready stage');
    const intervalsMs: number[] = [];
    let skippedRenderFrames = 0;
    const start = performance.now();
    let previous: number | null = null;
    let frame = stage.frames();
    await new Promise<void>((resolve) => {
      let done = false;
      let scheduled = 0;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(scheduled);
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(finish, 30_000);
      const sample = (now: number) => {
        if (done) return;
        const next = stage.frames();
        if (next > frame) {
          if (previous !== null) {
            intervalsMs.push(now - previous);
            skippedRenderFrames += Math.max(0, next - frame - 1);
          }
          previous = now;
          frame = next;
        }
        if (intervalsMs.length >= 180) finish();
        else scheduled = requestAnimationFrame(sample);
      };
      scheduled = requestAnimationFrame(sample);
    });
    const sorted = [...intervalsMs].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="worldstream-canvas"] canvas')
      ?? document.querySelector<HTMLCanvasElement>('canvas');
    const renderTiming=await stage.measureRender(60);
    return {
      status: intervalsMs.length === 180 ? 'complete' : 'insufficient-frames',
      elapsedMs: performance.now() - start,
      requestedIntervals: 180, intervalsMs, skippedRenderFrames,
      medianMs: sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
      p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      visible: document.visibilityState,
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      quality: stage.quality(), memory: stage.memory(),
      renderTiming,
    };
  });
}
