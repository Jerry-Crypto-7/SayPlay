'use client';
import { useMemo, useState, useSyncExternalStore } from 'react';
import WorldstreamCanvas, { type SharedCamera } from './WorldstreamCanvas';
import type { WorldDoc } from '@/ir/worlddoc';
import type { BranchComparison } from '@/worldstream/branch-controller';
import type { EntityNames } from '@/worldstream/comparison-narration';
import type { ProxyWorld } from '@/worldstream/proxy';
import type { RuntimeController } from '@/worldstream/runtime-controller';

/**
 * Jedna přijatá alternativa (P22 T10). Stránka si jich nechá nejvýš
 * `MAX_FUTURES`; všechny sdílejí tentýž `source` (runtime originálu), každá má
 * vlastní `target` – větev, kterou `forkAt` odbočil při přijetí.
 */
export interface AcceptedFuture {
  readonly id: number;
  /** Věta, kterou porotce napsal (u věty o víc věcech ten kus, který šel modelu). */
  readonly sentence: string;
  readonly result: BranchComparison;
  readonly world: ProxyWorld;
  readonly source: RuntimeController;
  readonly changedWorld: ProxyWorld;
  readonly target: RuntimeController;
  readonly summary: string;
  readonly names: EntityNames;
  readonly document: WorldDoc;
}

/** Nejstarší vypadne; nově přijatá je vždy ta zobrazená, takže nikdy nevypadne ona. */
export const MAX_FUTURES = 6;

/** Both sides consume one observation clock; a terminal branch remains at its end state. */
export default function FutureViews({ futures, selected, onSelect, reset, onPresented, cutaway }: {
  futures: readonly AcceptedFuture[]; selected: AcceptedFuture; onSelect: (id: number) => void;
  reset: number;
  onPresented?: (world: ProxyWorld) => void;
  cutaway?: boolean;
}) {
  const { world: original, changedWorld: changed, source, target } = selected;
  const { forkTick, observationTick: endTick } = selected.result;
  const sharedCamera = useMemo<SharedCamera>(() => ({ current: null, listeners: new Set() }), [original]);
  // Čas se čte z runtimu, ne z vlastního stavu: přepnutí položky přeskočí obě
  // strany na společný tik (`page.tsx`) a posuvník to musí ukázat bez efektu.
  const sourceState = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const targetState = useSyncExternalStore(target.subscribe, target.getSnapshot, target.getSnapshot);
  const tick = sourceState.observationTick;
  const [side, setSide] = useState<'original' | 'changed'>('changed');
  const seek = (next: number) => {
    source.setPaused(true); target.setPaused(true);
    source.observeAt(next); target.observeAt(next);
  };
  return <div className="ws-futures" data-testid="future-views" data-side={side}>
    <div className="ws-future-toolbar">
      <label>Compare the same moment · {(tick / 20).toFixed(1)}s
        <input data-testid="future-time" type="range" min={forkTick} max={endTick} value={tick}
          onChange={event => seek(event.target.valueAsNumber)} /></label>
      <button onClick={() => setSide('original')} aria-pressed={side === 'original'}>Original view</button>
      <button onClick={() => setSide('changed')} aria-pressed={side === 'changed'}>Changed view</button>
    </div>
    <nav className="ws-future-list" data-testid="future-list" aria-label="Futures">
      <strong>Futures</strong>
      {futures.map((future, index) => <button key={future.id} type="button" data-testid={`future-item-${index + 1}`}
        aria-pressed={future.id === selected.id} onClick={() => onSelect(future.id)}>
        <span>{index + 1}</span> {future.sentence}
      </button>)}
    </nav>
    <section className="ws-future-original" aria-label="Original future" data-testid="future-original"
      data-hash={sourceState.stateHash} data-tick={sourceState.observationTick}><strong>Original</strong>
      <WorldstreamCanvas world={original} controller={source} sceneId="comparison-original" reset={reset} sharedCamera={sharedCamera} onPresented={onPresented} cutaway={cutaway} />
    </section>
    <section className="ws-future-changed" aria-label="Changed future" data-testid="future-changed"
      data-hash={targetState.stateHash} data-tick={targetState.observationTick}><strong>Changed</strong>
      <WorldstreamCanvas world={changed} controller={target} sceneId="comparison-changed" reset={reset} sharedCamera={sharedCamera} onPresented={onPresented} cutaway={cutaway} />
    </section>
  </div>;
}
