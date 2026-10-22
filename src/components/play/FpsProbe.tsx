'use client';

import { useEffect, useState } from 'react';

/** Okno měření: AC HALTu P56B čte úroveň kvality po 15 s. */
const WINDOW_MS = 15_000;

interface Probe {
  readonly fps: number;
  readonly quality: string | null;
  readonly done: boolean;
}

/**
 * Měřidlo FPS na skutečném telefonu (HALT P56B): jen s `?fps=1` ukáže průběžné
 * FPS a `data-quality` z `arcade-stage`, po 15 s výsledek zamrazí. S `?report=<url>`
 * ho pošle na sběrač v síti vývojáře, aby majitel nic neopisoval. Wall-clock je tu
 * v pořádku: měřidlo je mimo hashovaný stav a replay ho nevidí.
 */
export function FpsProbe() {
  const [probe, setProbe] = useState<Probe | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fps') !== '1') return;
    const report = params.get('report');
    const start = performance.now();
    let frames = 0;
    let windowStart = start;
    let windowFrames = 0;
    let raf = 0;
    const quality = () => document.querySelector('[data-testid="arcade-stage"]')?.getAttribute('data-quality') ?? null;
    const tick = (now: number) => {
      frames += 1;
      windowFrames += 1;
      if (now - start >= WINDOW_MS) {
        const result = { fps: Math.round((frames * 10_000) / (now - start)) / 10, quality: quality(), done: true };
        setProbe(result);
        if (report !== null && /^https?:\/\//.test(report))
          void fetch(report, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify({ ...result, path: window.location.pathname, ua: navigator.userAgent, dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight }),
          }).catch(() => undefined);
        return;
      }
      if (now - windowStart >= 1000) {
        setProbe({ fps: Math.round((windowFrames * 10_000) / (now - windowStart)) / 10, quality: quality(), done: false });
        windowStart = now;
        windowFrames = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (probe === null) return null;
  return (
    <div
      data-testid="fps-probe"
      style={{
        position: 'fixed',
        top: 'var(--sp-space-2)',
        left: 'var(--sp-space-2)',
        zIndex: 1000,
        padding: 'var(--sp-space-1) var(--sp-space-2)',
        background: 'var(--sp-surface)',
        color: 'var(--sp-text)',
        border: 'var(--sp-border-base) solid var(--sp-outline)',
        fontSize: 'var(--sp-text-body-s-size)',
        pointerEvents: 'none',
      }}
    >
      {probe.done ? 'Done' : 'Measuring'} · {probe.fps} FPS · {probe.quality ?? '–'}
    </div>
  );
}
