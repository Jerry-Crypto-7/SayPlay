'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RuntimeController } from '@/worldstream/runtime-controller';

/** Controls send inputs; all positions, outcomes and rule IDs come back from the runtime. */
export default function RuntimeInteraction({ controller }: { readonly controller: RuntimeController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [selected, setSelected] = useState('0');
  const [message, setMessage] = useState('Choose a destination or an action. Activation requires reaching the sensor.');
  useEffect(() => {
    setSelected('0');
    setMessage('Choose a destination or an action. Activation requires reaching the sensor.');
  }, [controller]);
  const action = controller.actions[Number(selected)];
  return <section aria-label="World interaction" style={{ flexBasis: '100%', display: 'grid', gap: 6, maxWidth: 420, maxHeight: '30dvh', overflow: 'auto' }}>
    <label>World action <select data-testid="runtime-action" value={selected}
      onChange={event => setSelected(event.target.value)} style={{ maxWidth: '100%', color: '#171717' }}>
      {controller.actions.map((entry, index) => <option key={index} value={index}>
        {entry.actionId === 'moveTo' ? 'Walk to' : entry.actionId} {entry.target ?? ''} ({entry.actor})
      </option>)}
    </select></label>
    <button type="button" data-testid="runtime-act" disabled={!state.canInput || !action} onClick={() => {
      if (!action) return;
      const result = controller.dispatch(action);
      setMessage(!result.ok ? result.reason : result.runState === 'runtimeFault' ? 'Simulation fault; no transition applied.'
        : `Input at tick ${result.tick}. ${result.ruleIds.length ? `Applied: ${result.ruleIds.join(', ')}` : 'No rule applied; conditions were not met.'}`);
    }}>Perform action</button>
    <output data-testid="runtime-input-result" aria-live="polite">{message}</output>
    <div data-testid="runtime-positions">{state.entities.filter(entity =>
      controller.actions.some(entry => entry.actor === entity.stableId)).map(entity =>
      <span key={entity.stableId}>{entity.stableId}: ({entity.x}, {entity.y}) </span>)}</div>
    <div data-testid="runtime-outcomes">{Object.entries(state.values).filter(([id]) =>
      id.startsWith('f:') || id.startsWith('t:') || id.endsWith(':locked')).map(([id, value]) =>
      <span key={id} data-testid={`runtime-value-${id}`} style={{ display: 'inline-block', marginRight: 8 }}>
        {id.startsWith('f:') ? `${id.slice(2)}: ${value ? 'on' : 'off'}`
          : id.endsWith(':locked') ? `${id.slice(2, -7)}: ${value ? 'locked' : 'unlocked'}`
            : `${id.slice(2)}: ${value} ticks`}
      </span>)}</div>
    <details><summary>Rule trace</summary>
      <ol data-testid="runtime-rule-trace" style={{ maxHeight: 110, overflow: 'auto', margin: 0, paddingLeft: 24 }}>
        {state.transitions.map((entry, index) => <li key={`${entry.tick}-${index}`}>
          Tick {entry.tick}: {entry.inputs.map(input => `${input.actionId} ${input.target ?? ''}`).join(', ') || 'Simulation'}
          {' → '}{entry.ruleIds.join(', ') || 'No rule applied'}
        </li>)}
      </ol>
    </details>
  </section>;
}
