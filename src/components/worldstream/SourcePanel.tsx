'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sealSimHash } from '@/ir/worlddoc';
import { createEvidenceProject, type ProjectRevision } from '@/worldstream/evidence-commit';
import type { SourceScenarioResult } from '@/model/source-scenario';
import type { RuntimeController } from '@/worldstream/runtime-controller';
import { EVIDENCE_LIMITS } from '@/worldstream/evidence';
import BranchComparison from './BranchComparison';
import { sourceObservation } from '@/worldstream/browser-measurement';

export type SourceGeneration = 'live' | 'fixture';
export default function SourcePanel({ project, controller, epoch, disabled, onAccept, onBegin }: {
  project: ProjectRevision | null; controller: RuntimeController | null; epoch: number; disabled: boolean;
  onAccept: (project: ProjectRevision, generation: SourceGeneration) => void;
  onBegin: () => void;
}) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('My source');
  const [origin, setOrigin] = useState<'own' | 'provided'>('provided');
  const [rights, setRights] = useState<'owned' | 'licensed' | 'unreviewed'>('unreviewed');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('Paste a short source. Missing critical conditions require clarification before a world can run.');
  const [questions, setQuestions] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<ProjectRevision | null>(null);
  const [generation, setGeneration] = useState<SourceGeneration>('live');
  useEffect(() => {
    const probe = { snapshot: () => sourceObservation(project, controller, generation) };
    window.__realityCompiler = probe;
    return () => { if (window.__realityCompiler === probe) delete window.__realityCompiler; };
  }, [project, controller, generation]);
  const store = useRef<ReturnType<typeof createEvidenceProject> | null>(null);
  const operation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    operation.current++;
    abort.current?.abort();
    setBusy(false);
    setQuestions([]);
    setNotice('Paste a short source. Missing critical conditions require clarification before a world can run.');
    return () => { operation.current++; abort.current?.abort(); };
  }, [epoch]);
  const [ruleId, setRuleId] = useState('');
  const [ticks, setTicks] = useState(200);
  const [fork, setFork] = useState(0);
  const [horizon, setHorizon] = useState(300);
  const [reason, setReason] = useState('');
  const count = [...text].length;
  const tooLarge = count > EVIDENCE_LIMITS.sourceCodePoints || new TextEncoder().encode(text).length > EVIDENCE_LIMITS.sourceBytes;
  async function submit() {
    if (busy || disabled || !text.trim() || tooLarge) return;
    onBegin();
    const era = ++operation.current;
    const control = new AbortController();
    abort.current?.abort(); abort.current = control;
    setBusy(true); setQuestions([]); setNotice('Reading the source…');
    try {
      const response = await fetch('/api/worldstream/source', { method: 'POST', signal: control.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, title, origin, rights }) });
      const result = await response.json() as SourceScenarioResult & { generation?: SourceGeneration };
      if (era !== operation.current) return;
      if (result.kind === 'needsClarification') {
        setQuestions([...result.questions, ...result.conflicts.map(value => `Conflict: ${value}`),
          ...result.unsupported.map(value => `Unsupported: ${value}`)]);
        setNotice('Clarification required. Revise the source and submit again. The current world is unchanged.');
        return;
      }
      if (!response.ok || result.kind !== 'proposed') {
        setNotice(`Source could not be accepted (${result.kind === 'rejected' ? result.code : 'INVALID_RESPONSE'}). The current world is unchanged.`);
        return;
      }
      if (result.source.text !== text || result.source.title !== title || result.source.origin !== origin || result.source.rights !== rights) {
        setNotice('The returned source does not match your input. The current world is unchanged.'); return;
      }
      const candidate = createEvidenceProject();
      const committed = await candidate.commitInitial({ base: null, sources: [result.source], evidence: result.evidence,
        world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: result.sim,
          look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } }) });
      if (era !== operation.current) return;
      if (!committed.ok) { setNotice(`Source validation failed: ${committed.issues.join(', ')}. The current world is unchanged.`); return; }
      const provenance = result.generation === 'fixture' ? 'fixture' : 'live';
      onAccept(committed.value, provenance);
      store.current = candidate; setAccepted(committed.value); setGeneration(provenance);
      setEditing(false);
      setRuleId(Object.entries(committed.value.world.sim.rules as Record<string, { actions?: { kind: string }[] }> )
        .find(([, rule]) => rule.actions?.some(action => action.kind === 'startTimer'))?.[0] ?? '');
      setReason('');
      setNotice('Source accepted. Citations are unchecked; structural validation does not confirm their meaning.');
    } catch {
      if (era === operation.current) setNotice('Source request failed. The current world is unchanged.');
    } finally { if (era === operation.current) setBusy(false); }
  }
  async function intervene() {
    if (!store.current || !project || !controller || busy) return;
    const era = ++operation.current;
    setBusy(true);
    try {
      const result = await store.current.commitIntervention({ base: project.projectRevision, ruleId,
        durationTicks: ticks, forkTick: fork, observationTick: horizon, reason }, controller);
      if (era !== operation.current) return;
      if (!result.ok) { setNotice(`Intervention refused: ${result.issues.join(', ')}. The current revision is unchanged.`); return; }
      onAccept(result.value, generation); setAccepted(result.value);
      setNotice('Intervention accepted as an unchecked experimental assumption. Original source preserved.');
    } catch { if (era === operation.current) setNotice('Intervention could not be displayed.'); }
    finally { if (era === operation.current) setBusy(false); }
  }
  return <section className="ws-source" data-testid="source-panel" style={PANEL} aria-label="Source and evidence">
    <details open={editing} onToggle={event => setEditing(event.currentTarget.open)}>
      <summary>Build from a source</summary>
      <form onSubmit={event => { event.preventDefault(); void submit(); }} style={{ display: 'grid', gap: 8 }}>
        <label>Source title <input value={title} maxLength={256} required disabled={busy}
          onChange={event => setTitle(event.target.value)} /></label>
        <label>Source text <textarea data-testid="source-input" value={text} rows={5} required disabled={busy}
          onChange={event => setText(event.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} /></label>
        <span>{count} / 4000 characters{tooLarge ? ' — source is too large' : ''}</span>
        <label>Source origin <select value={origin} disabled={busy} onChange={event => setOrigin(event.target.value as typeof origin)}>
          <option value="provided">Provided text</option><option value="own">My own text</option>
        </select></label>
        <label>Rights status <select value={rights} disabled={busy} onChange={event => setRights(event.target.value as typeof rights)}>
          <option value="unreviewed">Not reviewed</option><option value="owned">I own this text</option><option value="licensed">Licensed</option>
        </select></label>
        <button type="submit" data-testid="source-submit" disabled={busy || disabled || tooLarge || !text.trim()}>
          {busy ? 'Working…' : 'Build from source'}</button>
      </form>
    </details>
    <p role="status" data-testid="source-status">{notice}</p>
    {questions.length > 0 && <ul data-testid="source-questions">{questions.map((question, index) => <li key={index}>{question}</li>)}</ul>}
    {project && <>
      <p data-testid="source-provenance">{generation === 'fixture' ? 'Scripted test fixture; no live generation.' : 'Scenario generated from your source.'}
        {' '}Schematic geometry; appearance is not sourced. This project stays in this tab.</p>
      <details><summary>Original source</summary>{project.sources.map(source => <div key={source.sourceId}>
        <strong>{source.title}</strong><pre data-testid="source-bytes" style={{ whiteSpace: 'pre-wrap' }}>{source.text}</pre>
      </div>)}</details>
      {controller && <SourceExplanation key={project.projectRevision} project={project} controller={controller} />}
      {accepted?.parent && accepted.comparison && <BranchComparison comparison={accepted.comparison}
        original={project === accepted.parent} busy={busy} scope="tab"
        onOriginal={() => onAccept(accepted.parent!, generation)} onChanged={() => onAccept(accepted, generation)} />}
      {!accepted?.parent && ruleId && <details><summary>Experiment with a future timer</summary>
        <form onSubmit={event => { event.preventDefault(); void intervene(); }} style={{ display: 'grid', gap: 8 }}>
          <p>This changes a rule as an assumption; it does not rewrite the source. One intervention per project.</p>
          <label>Timer rule <select value={ruleId} onChange={event => setRuleId(event.target.value)}>
            {Object.entries(project.world.sim.rules as Record<string, { actions?: { kind: string }[] }>).filter(([, rule]) =>
              rule.actions?.some(action => action.kind === 'startTimer')).map(([id]) => <option key={id}>{id}</option>)}
          </select></label>
          <label>New duration (ticks, 20 per second) <input type="number" min={1} max={3600} value={ticks} required onChange={event => setTicks(event.target.valueAsNumber)} /></label>
          <label>Fork tick <input type="number" min={0} max={3600} value={fork} required onChange={event => setFork(event.target.valueAsNumber)} /></label>
          <label>Observation tick <input type="number" min={fork} max={12000} value={horizon} required onChange={event => setHorizon(event.target.valueAsNumber)} /></label>
          <label>Reason for intervention <input value={reason} maxLength={2000} required onChange={event => setReason(event.target.value)} /></label>
          <button disabled={busy || disabled} type="submit">Confirm timer experiment</button>
        </form>
      </details>}
    </>}
  </section>;
}

function SourceExplanation({ project, controller }: { project: ProjectRevision; controller: RuntimeController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const explanation = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) explanation.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const fired = state.transitions.flatMap(entry => entry.ruleIds.map(ruleId => ({ tick: entry.tick, ruleId })));
  const transition = fired.find(entry => `${entry.tick}:${entry.ruleId}` === selected);
  const rule = transition ? (project.world.sim.rules as Record<string, { condition: unknown; actions: unknown }>)[transition.ruleId] : null;
  const claims = transition ? project.evidence.bindings.filter(binding => binding.target.kind === 'rule' && binding.target.id === transition.ruleId)
    .flatMap(binding => binding.claimIds).filter((id, index, ids) => ids.indexOf(id) === index)
    .map(id => project.evidence.claims.find(claim => claim.claimId === id)!) : [];
  return <details><summary>Why?</summary>
    <p data-testid="evidence-revision">Branch {project.branchId} · revision {project.evidence.worldRevision}</p>
    <details><summary>Evidence revision details</summary><p>{project.evidence.evidenceHash}</p></details>
    {fired.length === 0 ? <p>No rule has fired in this run yet.</p> : <label>Observed rule <select data-testid="why-rule"
      value={transition ? selected! : ''} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a fired rule</option>{fired.map((entry, index) => <option key={index} value={`${entry.tick}:${entry.ruleId}`}>
        Tick {entry.tick}: {entry.ruleId}</option>)}
    </select></label>}
    {transition && rule && <div ref={explanation} data-testid="why-explanation">
      <p>Runtime trace: {transition.ruleId} fired at tick {transition.tick} in {project.branchId}.</p>
      <details><summary>Rule condition and declared effects</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ condition: rule.condition, actions: rule.actions }, null, 2)}</pre>
        <p>The trace records firing; these are the rule declarations, not a separate measurement of every effect.</p>
      </details>
      {claims.map(claim => <article key={claim.claimId}>
        <p>{claim.text}</p><dl data-testid="claim-axes">
          <dt>Support</dt><dd>{claim.support}</dd><dt>Intervention</dt><dd>{claim.interventionId === null ? 'original' : 'changed'}</dd>
          <dt>Review</dt><dd>{claim.review.status}</dd>
        </dl>
        {claim.support === 'sourced' && claim.spans.map((span, index) => <blockquote key={index}>
          <q>{span.excerpt}</q><footer>{project.sources.find(source => source.sourceId === span.sourceId)?.title} · bytes {span.startByte}–{span.endByte}</footer>
        </blockquote>)}
        {claim.support === 'derived' && <p>Derivation: {claim.derivation}. Premises: {claim.premiseClaimIds.map(id =>
          project.evidence.claims.find(premise => premise.claimId === id)?.text ?? id).join('; ')}</p>}
        {claim.support === 'assumed' && <p>Assumption: {claim.reason}</p>}
        {claim.interventionId && <p>{project.evidence.interventions.filter(entry => entry.interventionId === claim.interventionId)
          .map(entry => `${entry.before} → ${entry.after}; ${entry.reason}`).join('; ')}</p>}
      </article>)}
      <p>Unchecked support is not a confirmed explanation of the real world.</p>
    </div>}
  </details>;
}

const PANEL: React.CSSProperties = { pointerEvents: 'auto', padding: '0.6rem 0.75rem', borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.94)', color: '#cfe3e6', font: '13px/1.5 system-ui, sans-serif',
  maxHeight: '34dvh', overflow: 'auto', overflowWrap: 'anywhere' };
