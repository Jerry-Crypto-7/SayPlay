'use client';
import { useMemo, useState } from 'react';
import WorldstreamCanvas, { type SharedCamera } from './WorldstreamCanvas';
import type { ProxyWorld } from '@/worldstream/proxy';
import type { RuntimeController } from '@/worldstream/runtime-controller';

/** Both sides consume one observation clock; a terminal branch remains at its end state. */
export default function FutureViews({ original, changed, source, target, forkTick, endTick, reset, onPresented, cutaway }: {
  original: ProxyWorld; changed: ProxyWorld; source: RuntimeController; target: RuntimeController;
  forkTick: number; endTick: number; reset: number;
  onPresented?: (world: ProxyWorld) => void;
  cutaway?: boolean;
}) {
  const sharedCamera = useMemo<SharedCamera>(() => ({ current: null, listeners: new Set() }), [original]);
  const [tick, setTick] = useState(endTick);
  const [side, setSide] = useState<'original' | 'changed'>('changed');
  const seek = (next: number) => {
    source.setPaused(true); target.setPaused(true);
    source.observeAt(next); target.observeAt(next); setTick(next);
  };
  return <div className="ws-futures" data-testid="future-views" data-side={side}>
    <div className="ws-future-toolbar">
      <label>Compare the same moment · {(tick / 20).toFixed(1)}s
        <input data-testid="future-time" type="range" min={forkTick} max={endTick} value={tick}
          onChange={event => seek(event.target.valueAsNumber)} /></label>
      <button onClick={() => setSide('original')} aria-pressed={side === 'original'}>Original view</button>
      <button onClick={() => setSide('changed')} aria-pressed={side === 'changed'}>Changed view</button>
    </div>
    <section className="ws-future-original" aria-label="Original future"><strong>Original</strong>
      <WorldstreamCanvas world={original} controller={source} sceneId="comparison-original" reset={reset} sharedCamera={sharedCamera} onPresented={onPresented} cutaway={cutaway} />
    </section>
    <section className="ws-future-changed" aria-label="Changed future"><strong>Changed</strong>
      <WorldstreamCanvas world={changed} controller={target} sceneId="comparison-changed" reset={reset} sharedCamera={sharedCamera} onPresented={onPresented} cutaway={cutaway} />
    </section>
  </div>;
}
