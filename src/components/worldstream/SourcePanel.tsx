'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { sealSimHash } from '@/ir/worlddoc';
import { createEvidenceProject, type ProjectRevision } from '@/worldstream/evidence-commit';
import type { SourceScenarioResult } from '@/model/source-scenario';
import type { RuntimeController } from '@/worldstream/runtime-controller';
import { EVIDENCE_LIMITS, evidenceRevisionSchema } from '@/worldstream/evidence';
import { supplementInput } from '@/worldstream/source-input';
import { ruleSupportParts, supportPartLabel } from '@/worldstream/rule-support';
import type { createPipelineMetrics, PipelineRunHandle, PipelineStageHandle, PipelineProvenance } from '@/worldstream/pipeline-metrics';
import BranchComparison from './BranchComparison';
import { sourceObservation } from '@/worldstream/browser-measurement';
import { explicitTimerIssues, PARAMETER_KEYS, PARAMETER_LABELS, parameterDeclarations, parameterProposalHash,
  type ParameterKey } from '@/worldstream/source-parameters';
import { decodeSourceProject, encodeSourceProject, SOURCE_PROJECT_STORAGE_KEY, type RestoredSourceProject } from '@/worldstream/project-storage';

export type SourceGeneration = 'live' | 'fixture';
export default function SourcePanel({ project, controller, epoch, disabled, onAccept, onBegin, runtimes, onRestore,
  metrics, onMeasurementRun, onMeasureDisplay }: {
  project: ProjectRevision | null; controller: RuntimeController | null; epoch: number; disabled: boolean;
  onAccept: (project: ProjectRevision, generation: SourceGeneration) => void;
  onBegin: () => void;
  runtimes: ReadonlyMap<ProjectRevision, RuntimeController>;
  onRestore: (restored: RestoredSourceProject) => void;
  metrics: ReturnType<typeof createPipelineMetrics>;
  onMeasurementRun: (run: PipelineRunHandle) => void;
  onMeasureDisplay: (run: PipelineRunHandle, provenance: PipelineProvenance, initialInputs?: number) => void;
}) {
  const [text, setText] = useState('');
  const [supplement, setSupplement] = useState('');
  const [title, setTitle] = useState('My source');
  const [origin, setOrigin] = useState<'own' | 'provided'>('provided');
  const [rights, setRights] = useState<'owned' | 'licensed' | 'unreviewed'>('unreviewed');
  const [busy, setBusy] = useState(false);
  const [readingSource, setReadingSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('Paste a short source. Missing critical conditions require clarification before a world can run.');
  const [questions, setQuestions] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<ProjectRevision | null>(null);
  const [generation, setGeneration] = useState<SourceGeneration>('live');
  const [pending, setPending] = useState<{ result: Extract<SourceScenarioResult, { kind: 'proposed' }>;
    generation: SourceGeneration; hash: string } | null>(null);
  const [checks, setChecks] = useState<Partial<Record<ParameterKey, string>>>({});
  const declarations = useMemo(() => pending ? parameterDeclarations(pending.result.sim) : null, [pending]);
  const measurement = useRef<PipelineRunHandle | null>(null);
  const reviewStage = useRef<PipelineStageHandle | null>(null);
  function invalidateDraft(discard = true) {
    if (discard && measurement.current) metrics.finishRun(measurement.current, 'cancelled');
    if (discard) measurement.current = null;
    reviewStage.current = null; setPending(null); setChecks({});
  }
  function beginMeasurement(era: number, provenance: PipelineProvenance = 'unknown') {
    const run = metrics.startRun({ generation: era, kind: 'source', provenance });
    measurement.current = run; onMeasurementRun(run); return run;
  }
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
    setReadingSource(false);
    invalidateDraft();
    setQuestions([]);
    setNotice('Paste a short source. Missing critical conditions require clarification before a world can run.');
    return () => { operation.current++; abort.current?.abort();
      if (measurement.current) metrics.finishRun(measurement.current, 'cancelled'); };
  }, [epoch]);
  const [ruleId, setRuleId] = useState('');
  const [ticks, setTicks] = useState(200);
  const [fork, setFork] = useState(0);
  const [horizon, setHorizon] = useState(300);
  const [reason, setReason] = useState('');
  const count = [...text].length;
  const tooLarge = count > EVIDENCE_LIMITS.sourceCodePoints || [...supplement].length > EVIDENCE_LIMITS.sourceCodePoints ||
    new TextEncoder().encode(text + supplement).length > EVIDENCE_LIMITS.sourceBytes;
  function matchesInput(result: Extract<SourceScenarioResult, { kind: 'proposed' }>) {
    const added = result.supplements ?? [];
    const expected = supplement ? supplementInput(supplement) : null;
    return result.source.text === text && result.source.title === title && result.source.origin === origin && result.source.rights === rights &&
      (expected ? added.length === 1 && Object.entries(expected).every(([key, value]) => added[0][key as keyof typeof expected] === value)
        : added.length === 0);
  }
  function saveProject() {
    if (!project || busy || disabled) return;
    try {
      const saved = encodeSourceProject(accepted ?? project, project, runtimes, generation);
      localStorage.setItem(SOURCE_PROJECT_STORAGE_KEY, saved);
      setNotice('Source project saved in this browser, including both branches and visitor inputs. Restore it here after a reload.');
    } catch { setNotice('The project could not be saved in this browser. The current world and any previous save are unchanged.'); }
  }
  async function restoreProject() {
    if (busy || disabled) return;
    const era = ++operation.current;
    abort.current?.abort(); setBusy(true);
    invalidateDraft();
    const run = beginMeasurement(era, 'cache');
    const validation = metrics.startStage(run, 'validation', 'cache');
    try {
      const saved = localStorage.getItem(SOURCE_PROJECT_STORAGE_KEY);
      if (!saved) { metrics.finishRun(run, 'failed'); setNotice('No saved source project was found in this browser.'); return; }
      const restored = await decodeSourceProject(saved);
      if (era !== operation.current) return;
      metrics.finishStage(validation);
      onMeasureDisplay(run, 'cache', restored.runtimes.get(restored.selected)?.getInputLog().length ?? 0);
      onRestore(restored);
      measurement.current = null;
      store.current = restored.store; setAccepted(restored.head); setGeneration(restored.generation);
      const source = restored.selected.sources[0];
      setText(source.text); setTitle(source.title); setOrigin(source.origin === 'own' ? 'own' : 'provided'); setRights(source.rights);
      setSupplement(restored.selected.sources.find(source => source.origin === 'user-supplement')?.text ?? '');
      setRuleId(Object.entries(restored.head.world.sim.rules as Record<string, { actions?: { kind: string }[] }>)
        .find(([, rule]) => rule.actions?.some(action => action.kind === 'startTimer'))?.[0] ?? '');
      setQuestions([]); invalidateDraft(false); setEditing(false);
      setNotice('Saved source project restored by validated replay. The view is paused; citations remain unchecked.');
    } catch { metrics.finishRun(run, 'failed'); if (era === operation.current) setNotice('The saved source project is invalid or unavailable. The current world is unchanged.'); }
    finally { if (era === operation.current) setBusy(false); }
  }
  async function submit() {
    if (busy || disabled || !text.trim() || tooLarge) return;
    onBegin();
    const era = ++operation.current;
    const control = new AbortController();
    abort.current?.abort(); abort.current = control;
    setBusy(true); setReadingSource(true); setQuestions([]); invalidateDraft(); setNotice('Reading the source…');
    const run = beginMeasurement(era);
    const request = metrics.startStage(run, 'source-request');
    try {
      const response = await fetch('/api/worldstream/source', { method: 'POST', signal: control.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, title, origin, rights, ...(supplement ? { supplement } : {}) }) });
      metrics.finishStage(request);
      const parsing = metrics.startStage(run, 'response-parse');
      const result = await response.json() as SourceScenarioResult & { generation?: SourceGeneration };
      metrics.finishStage(parsing);
      if (era !== operation.current) return;
      metrics.setRunProvenance(run, result.generation === 'fixture' ? 'fixture' : result.generation === 'live' ? 'live' : 'unknown');
      if (result.kind === 'needsClarification') {
        metrics.finishRun(run, 'failed');
        if (![result.questions, result.conflicts, result.unsupported].every(values =>
          Array.isArray(values) && values.length <= 64 && values.every(value =>
            typeof value === 'string' && value.trim().length > 0 && value.length <= 2_000))) {
          setNotice('Source clarification has an invalid format. The current world is unchanged.'); return;
        }
        setQuestions([...result.questions, ...result.conflicts.map(value => `Conflict: ${value}`),
          ...result.unsupported.map(value => `Unsupported: ${value}`)]);
        setNotice('Clarification required. Add an explicit user supplement or revise your input, then build again. The current world is unchanged.');
        return;
      }
      if (!response.ok || result.kind !== 'proposed') {
        metrics.finishRun(run, 'failed');
        setNotice(`Source could not be accepted (${result.kind === 'rejected' ? result.code : 'INVALID_RESPONSE'}). The current world is unchanged.`);
        return;
      }
      const validation = metrics.startStage(run, 'validation');
      if (!matchesInput(result)) {
        metrics.finishRun(run, 'failed');
        setNotice('The returned source does not match your input. The current world is unchanged.'); return;
      }
      // Review renders individual bindings before commit. Reject malformed wire
      // data here; the atomic commit still checks hashes, references and support.
      if (!evidenceRevisionSchema.safeParse(result.evidence).success) {
        metrics.finishRun(run, 'failed');
        setNotice('Source evidence has an invalid format. The current world is unchanged.'); return;
      }
      const issues = explicitTimerIssues(result.sim);
      if (issues.length) { metrics.finishRun(run, 'failed'); setQuestions(issues); setNotice('Clarification required before this scenario can run.'); return; }
      const hash = await parameterProposalHash(result.sim, [result.source, ...(result.supplements ?? [])], result.evidence);
      if (era !== operation.current) return;
      metrics.finishStage(validation);
      reviewStage.current = metrics.startStage(run, 'parameter-review');
      setPending({ result, hash, generation: result.generation === 'fixture' ? 'fixture' : 'live' });
      setNotice('Review every critical parameter against the source before starting. Missing or conflicting support blocks acceptance.');
    } catch {
      metrics.finishRun(run, 'failed');
      if (era === operation.current) setNotice('Source request failed. The current world is unchanged.');
    } finally { if (era === operation.current) { setBusy(false); setReadingSource(false); } }
  }
  function stopReading() {
    operation.current++;
    abort.current?.abort();
    setBusy(false); setReadingSource(false); invalidateDraft();
    setNotice('Stopped waiting for this source. Its result will not be accepted. The current world is unchanged; a remote request may still finish.');
  }
  async function confirmParameters() {
    if (!pending || busy || disabled || !PARAMETER_KEYS.every(key => checks[key] === 'supported')) return;
    const { result } = pending;
    if (!matchesInput(result)) {
      invalidateDraft(); return;
    }
    const era = ++operation.current;
    setBusy(true);
    const run = measurement.current;
    if (!run) { setBusy(false); return; }
    metrics.finishStage(reviewStage.current);
    const acceptance = metrics.startStage(run, 'acceptance');
    try {
      const candidate = createEvidenceProject();
      const committed = await candidate.commitInitial({ base: null, sources: [result.source, ...(result.supplements ?? [])], evidence: result.evidence,
        parameterConfirmation: { version: 'source-parameters-v1', proposalHash: pending.hash, confirmed: [...PARAMETER_KEYS] },
        world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: result.sim,
          look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } }) });
      if (era !== operation.current) return;
      if (!committed.ok) { metrics.finishRun(run, 'failed'); setNotice(`Source validation failed: ${committed.issues.join(', ')}. The current world is unchanged.`); return; }
      const provenance = pending.generation;
      onMeasureDisplay(run, provenance);
      onAccept(committed.value, provenance);
      metrics.finishStage(acceptance);
      metrics.finishRun(run);
      measurement.current = null;
      store.current = candidate; setAccepted(committed.value); setGeneration(provenance);
      setEditing(false);
      setRuleId(Object.entries(committed.value.world.sim.rules as Record<string, { actions?: { kind: string }[] }> )
        .find(([, rule]) => rule.actions?.some(action => action.kind === 'startTimer'))?.[0] ?? '');
      setReason('');
      invalidateDraft(false);
      setNotice('Source accepted. Citations are unchecked; structural validation does not confirm their meaning.');
    } catch {
      metrics.finishRun(run, 'failed');
      if (era === operation.current) setNotice('Source acceptance failed. The current world is unchanged.');
    } finally { if (era === operation.current) setBusy(false); }
  }
  async function intervene() {
    if (!store.current || !project || !controller || busy) return;
    const era = ++operation.current;
    setBusy(true);
    invalidateDraft();
    const run = beginMeasurement(era, 'prepared');
    const comparison = metrics.startStage(run, 'compare', 'prepared');
    try {
      const result = await store.current.commitIntervention({ base: project.projectRevision, ruleId,
        durationTicks: ticks, forkTick: fork, observationTick: horizon, reason }, controller);
      if (era !== operation.current) return;
      if (!result.ok) { metrics.finishRun(run, 'failed'); setNotice(`Intervention refused: ${result.issues.join(', ')}. The current revision is unchanged.`); return; }
      metrics.finishStage(comparison);
      onMeasureDisplay(run, 'prepared');
      onAccept(result.value, generation); setAccepted(result.value);
      measurement.current = null;
      setNotice('Intervention accepted as an unchecked experimental assumption. Original source preserved.');
    } catch { metrics.finishRun(run, 'failed'); if (era === operation.current) setNotice('Intervention could not be displayed.'); }
    finally { if (era === operation.current) setBusy(false); }
  }
  return <section className="ws-source" data-testid="source-panel" style={PANEL} aria-label="Source and evidence">
    <details open={editing} onToggle={event => setEditing(event.currentTarget.open)}>
      <summary>Build from a source</summary>
      <form onSubmit={event => { event.preventDefault(); void submit(); }} style={{ display: 'grid', gap: 8 }}>
        <label>Source title <input value={title} maxLength={256} required disabled={busy}
          onChange={event => { invalidateDraft(); setTitle(event.target.value); }} /></label>
        <label>Source text <textarea data-testid="source-input" value={text} rows={5} required disabled={busy}
          onChange={event => { invalidateDraft(); setText(event.target.value); }} style={{ width: '100%', boxSizing: 'border-box' }} /></label>
        <span>{count} / 4000 characters{tooLarge ? ' — source is too large' : ''}</span>
        <label>User supplement (optional) <textarea data-testid="source-supplement" value={supplement} rows={3} disabled={busy}
          onChange={event => { invalidateDraft(); setSupplement(event.target.value); }} style={{ width: '100%', boxSizing: 'border-box' }} /></label>
        <small>Add missing conditions here. This is stored and cited separately as your addition, not as part of the original source or independent review.</small>
        <label>Source origin <select value={origin} disabled={busy} onChange={event => { invalidateDraft(); setOrigin(event.target.value as typeof origin); }}>
          <option value="provided">Provided text</option><option value="own">My own text</option>
        </select></label>
        <label>Rights status <select value={rights} disabled={busy} onChange={event => { invalidateDraft(); setRights(event.target.value as typeof rights); }}>
          <option value="unreviewed">Not reviewed</option><option value="owned">I own this text</option><option value="licensed">Licensed</option>
        </select></label>
        <button type="submit" data-testid="source-submit" disabled={busy || disabled || tooLarge || !text.trim()}>
          {busy ? 'Working…' : 'Build from source'}</button>
      </form>
    </details>
    <p role="status" data-testid="source-status">{notice}</p>
    {readingSource && <button data-testid="source-cancel" onClick={stopReading}>Stop waiting for source</button>}
    <div>
      {project && <button data-testid="source-save" disabled={busy || disabled} onClick={saveProject}>Save source project</button>}
      <button data-testid="source-restore" disabled={busy || disabled} onClick={() => void restoreProject()}>Restore saved source project</button>
    </div>
    {pending && <section data-testid="source-parameter-review" aria-label="Review critical parameters">
      <p>Compare each declaration with your source. Confirm only explicit, consistent support. Your acknowledgement is not independent semantic review.</p>
      <details><summary>Source to check</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{pending.result.source.text}</pre></details>
      {pending.result.supplements?.map(source => <details key={source.sourceId}><summary>User supplement to check</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{source.text}</pre></details>)}
      <details data-testid="proposal-rule-support"><summary>Check support for each rule component</summary>
        <p>These are proposed citations, not verified meaning. Check every trigger, condition and action against its cited text.</p>
        {pending.result.evidence.bindings.map(binding => <details key={binding.bindingId}>
          <summary>{binding.target.id}: {binding.part ? supportPartLabel(binding.part) : 'whole rule (legacy evidence)'}</summary>
          {binding.claimIds.map(id => pending.result.evidence.claims.find(claim => claim.claimId === id)).map(claim => claim && <div key={claim.claimId}>
            <p>{claim.text} ({claim.support}, {claim.review.status})</p>
            {claim.support === 'sourced' && claim.spans.map((span, index) => <blockquote key={index}><q>{span.excerpt}</q>
              <footer>{span.sourceId === pending.result.source.sourceId ? pending.result.source.title : 'User supplement — not original source'}
                {' '}· bytes {span.startByte}–{span.endByte}</footer></blockquote>)}
            {claim.support === 'derived' && <p>{claim.derivation}; premises: {claim.premiseClaimIds.join(', ')}</p>}
            {claim.support === 'assumed' && <p>{claim.reason}</p>}
          </div>)}
        </details>)}
      </details>
      {PARAMETER_KEYS.map(key => <fieldset key={key} disabled={busy}>
        <legend>{PARAMETER_LABELS[key]}</legend>
        <details><summary>Proposed {PARAMETER_LABELS[key].toLowerCase()}</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(declarations?.[key], null, 2)}</pre>
        </details>
        <label>Source support: {PARAMETER_LABELS[key]} <select data-testid={`parameter-${key}`} value={checks[key] ?? ''}
          onChange={event => setChecks(previous => ({ ...previous, [key]: event.target.value }))}>
          <option value="">Check against the source</option><option value="supported">Explicit and consistent</option>
          <option value="missing">Missing or unclear</option><option value="conflict">Conflicting</option>
        </select></label>
      </fieldset>)}
      {PARAMETER_KEYS.some(key => checks[key] === 'missing' || checks[key] === 'conflict') &&
        <p role="alert">This proposal cannot run. Resolve the missing or conflicting conditions with an explicit supplement or revised input and build again.</p>}
      <button data-testid="source-confirm" disabled={busy || disabled || !PARAMETER_KEYS.every(key => checks[key] === 'supported')}
        onClick={() => void confirmParameters()}>Confirm parameters and start</button>
      <button disabled={busy} onClick={() => invalidateDraft()}>Discard proposal</button>
    </section>}
    {questions.length > 0 && <ul data-testid="source-questions">{questions.map((question, index) => <li key={index}>{question}</li>)}</ul>}
    {project && <>
      <p data-testid="source-provenance">{generation === 'fixture' ? 'Scripted test fixture; no live generation.' : 'Scenario generated from your source.'}
        {' '}Schematic geometry; appearance is not sourced. Save this project to restore it in this browser.</p>
      <details><summary>Original source</summary>{project.sources.map(source => <div key={source.sourceId}>
        <strong>{source.title}{source.origin === 'user-supplement' ? ' · user addition, not original source' : ''}</strong>
        <pre data-testid={source.origin === 'user-supplement' ? 'supplement-bytes' : 'source-bytes'} style={{ whiteSpace: 'pre-wrap' }}>{source.text}</pre>
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
  const bindings = transition ? project.evidence.bindings.filter(binding => binding.target.kind === 'rule' && binding.target.id === transition.ruleId) : [];
  const components = useMemo(() => project.evidence.schemaVersion === 'worldstream-evidence-v2'
    ? ruleSupportParts(project.world.sim.rules) : null, [project]);
  const groups = components ? bindings.map(binding => ({ key: binding.bindingId, part: binding.part!, claimIds: binding.claimIds,
    declaration: components.find(part => part.ruleId === binding.target.id && part.part === binding.part)?.declaration }))
    : [{ key: 'legacy', part: null, declaration: null, claimIds: [...new Set(bindings.flatMap(binding => binding.claimIds))] }];
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
      {!components && <p>Legacy evidence links support to the whole rule. It does not identify support for each condition or action.</p>}
      {groups.map(group => <section key={group.key} data-testid={group.part ? `why-part-${group.part}` : 'why-legacy-support'}>
        {group.part && <><h4>{supportPartLabel(group.part)}</h4><details><summary>Executable declaration</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(group.declaration, null, 2)}</pre></details></>}
        {group.claimIds.map(id => project.evidence.claims.find(claim => claim.claimId === id)!).map(claim => <article key={claim.claimId}>
        <p>{claim.text}</p><dl data-testid="claim-axes">
          <dt>Support</dt><dd>{claim.support}</dd><dt>Intervention</dt><dd>{claim.interventionId === null ? 'original' : 'changed'}</dd>
          <dt>Review</dt><dd>{claim.review.status}</dd>
        </dl>
        {claim.support === 'sourced' && claim.spans.map((span, index) => <blockquote key={index}>
          <q>{span.excerpt}</q><footer>{project.sources.find(source => source.sourceId === span.sourceId)?.title}
            {project.sources.find(source => source.sourceId === span.sourceId)?.origin === 'user-supplement' ? ' · user addition, not original source' : ''}
            {' '}· bytes {span.startByte}–{span.endByte}</footer>
        </blockquote>)}
        {claim.support === 'derived' && <p>Derivation: {claim.derivation}. Premises: {claim.premiseClaimIds.map(id =>
          project.evidence.claims.find(premise => premise.claimId === id)?.text ?? id).join('; ')}</p>}
        {claim.support === 'assumed' && <p>Assumption: {claim.reason}</p>}
        {claim.interventionId && <p>{project.evidence.interventions.filter(entry => entry.interventionId === claim.interventionId)
          .map(entry => `${entry.before} → ${entry.after}; ${entry.reason}`).join('; ')}</p>}
      </article>)}
      </section>)}
      <p>Unchecked support is not a confirmed explanation of the real world.</p>
    </div>}
  </details>;
}

const PANEL: React.CSSProperties = { pointerEvents: 'auto', padding: '0.6rem 0.75rem', borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.94)', color: '#cfe3e6', font: '13px/1.5 system-ui, sans-serif',
  maxHeight: '34dvh', overflow: 'auto', overflowWrap: 'anywhere' };
