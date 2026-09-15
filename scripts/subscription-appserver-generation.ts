/** Offline protocol seam only. No OS launcher, authentication or readiness claim. */
import { createHash } from 'node:crypto';
import type { UpstreamRequest } from '../src/model/prompt';

export const APP_SERVER_GENERATION_LIMITS = Object.freeze({ jobMs: 180_000, cleanupMs: 5_000, outputBytes: 8 * 1024 * 1024 });
export const LINUX_SANDBOX_ADVISORY_SUMMARY = "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.";
export interface ConfigurationAdvisory {
  readonly kind: 'linux-sandbox-user-namespace-unavailable';
  readonly summary: typeof LINUX_SANDBOX_ADVISORY_SUMMARY;
  readonly details: null;
  readonly emittedAtMs?: number;
}
type Frame = Record<string, unknown>;
export type GenerationCleanup = { local: 'confirmed' | 'unknown'; remote: 'confirmed' | 'unknown' };
export interface GenerationTransport {
  /** Resolves only once the entire frame was written. Must not reenter onOutput synchronously. */
  send(frame: Readonly<Frame>): Promise<void>;
  /** Stop only this transport's owned process tree; not an interrupt acknowledgement. */
  close(): void;
  cleanup: Promise<GenerationCleanup>;
}
export interface GenerationTransportFactory {
  /** Trusted implementation owns source/runtime/auth isolation and complete raw byte delivery. */
  (callbacks: { onOutput(stream: 'stdout' | 'stderr', bytes: Uint8Array): void;
    /** Optional aggregate stdout+stderr count, including withheld bytes. Deliver after queued raw callbacks and before resolving cleanup. */
    onOutputAccounting?(report: { observedBytes: number | null }): void }, signal: AbortSignal): GenerationTransport;
}
export interface GenerationOutputAccounting {
  receivedBytes: number; receivedByStream: { stdout: number; stderr: number };
  /** Aggregate transport observation, never invented per-stream totals. */
  observedBytes: number | null; withheldBytes: number | null;
  status: 'unreported' | 'reported' | 'unknown' | 'invalid';
}
export interface GenerationResult {
  outcome: 'completed' | 'failed'; error: string | null; jsonText: string | null; json: Record<string, unknown> | null;
  outputBytes: number; wireRaw: string; stderrRaw: string; modelCalls: number | null; observedTurns: number;
  outputAccounting: GenerationOutputAccounting;
  configurationAdvisories: readonly ConfigurationAdvisory[];
  cleanup: GenerationCleanup; productionReady: false;
}
export interface LateGenerationEvidence { kind: 'output' | 'cleanup' | 'output-accounting'; bytes?: number; sha256?: string; cleanup?: GenerationCleanup;
  accounting?: GenerationOutputAccounting; error?: string | null }

const record = (value: unknown): value is Frame => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function fail(code: string): never { throw new Error(code); }
/** JSON.parse first validates grammar; second traversal rejects duplicate object keys and deep nesting. */
function strictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  let index = 0;
  const walk = (depth: number): void => {
    if (depth > 64) fail('JSON_DEPTH');
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set<string>();
      while (tokens[index] !== '}') {
        const key: string = JSON.parse(tokens[index++]);
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY'); keys.add(key); index++;
        walk(depth + 1); if (tokens[index] !== ',') break; index++;
      }
      index++;
    } else if (token === '[') {
      while (tokens[index] !== ']') { walk(depth + 1); if (tokens[index] !== ',') break; index++; }
      index++;
    }
  };
  walk(0); return parsed;
}

function threadRequest(system: string): Frame {
  return { id: 2, method: 'thread/start', params: {
    model: 'gpt-5.6-sol', modelProvider: 'openai', allowProviderModelFallback: false,
    cwd: '/work', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
    environments: [], dynamicTools: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [],
    developerInstructions: system,
    config: { model_reasoning_effort: 'low', model_catalog_json: '/usr/bin/text-model-catalog.json',
      'agents.enabled': false, 'features.shell_tool': false, 'features.apps': false,
      'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.image_generation': false,
      'features.goals': false, 'features.memories': false, 'features.plugins': false, 'features.code_mode': false,
      'features.code_mode_only': false, 'features.deferred_executor': false, 'features.token_budget': false,
      'features.current_time_reminder': false, 'features.skill_search': false,
      'tools.experimental_request_user_input.enabled': false, 'orchestrator.skills.enabled': false,
      'orchestrator.mcp.enabled': false, 'skills.include_instructions': false, web_search: 'disabled' },
  } };
}

/** One adapter per generation chain: unknown termination permanently fences subsequent calls. */
export function createAppServerGenerationAdapter(factory: GenerationTransportFactory) {
  let busy = false, blocked = false;
  return {
    async generate(input: { request: UpstreamRequest; remainingBudgetMs: number }, signal?: AbortSignal,
      onTurnStart?: () => void, onLate?: (evidence: LateGenerationEvidence) => void): Promise<GenerationResult> {
      const began = performance.now();
      const empty = (error: string): GenerationResult => ({ outcome: 'failed', error, jsonText: null, json: null,
        outputBytes: 0, wireRaw: '', stderrRaw: '', modelCalls: 0, observedTurns: 0,
        configurationAdvisories: Object.freeze([]),
        outputAccounting: { receivedBytes: 0, receivedByStream: { stdout: 0, stderr: 0 }, observedBytes: null, withheldBytes: null, status: 'unreported' },
        cleanup: { local: 'confirmed', remote: 'confirmed' }, productionReady: false });
      if (blocked) return empty('PRIOR_TERMINATION_UNKNOWN');
      if (busy) return empty('GENERATION_IN_PROGRESS');
      if (!record(input.request) || Object.keys(input.request).sort().join(',') !== 'model,system,user' ||
        input.request.model !== 'gpt-5.6-sol' || typeof input.request.system !== 'string' || typeof input.request.user !== 'string' ||
        !input.request.user.trim() || Buffer.byteLength(input.request.system + input.request.user) > 1024 * 1024 ||
        !Number.isFinite(input.remainingBudgetMs) || input.remainingBudgetMs <= 0) return empty('INVALID_GENERATION_REQUEST');
      if (signal?.aborted) return empty('GENERATION_CANCELLED');
      const request = { ...input.request };
      busy = true;
      const deadlineAt = began + Math.min(APP_SERVER_GENERATION_LIMITS.jobMs, input.remainingBudgetMs);
      const control = new AbortController();
      let transport: GenerationTransport | undefined, error: string | null = null, sealed = false, stopping = false;
      let outputBytes = 0, partial = '', threadId: string | null = null, turnId: string | null = null;
      // Lifetime received counters continue for late accounting comparisons;
      // returned result and outputBytes are immutable snapshots at sealing.
      const receivedByStream = { stdout: 0, stderr: 0 };
      let receivedTotal = 0, lastKnownObserved: number | null = null, observedBytes: number | null = null;
      let accountingStatus: GenerationOutputAccounting['status'] = 'unreported';
      let turnSent = false, turnStarted = false, completed = false, expected = 1;
      let announcedThread: string | null = null;
      let remoteStatusObserved = false;
      const items = new Map<string, { type: string; text: string; done: boolean }>();
      const completedItems = new Map<string, Frame>();
      const delivered = new Set<number>(), stdout: Buffer[] = [], stderr: Buffer[] = [];
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const configurationAdvisories: ConfigurationAdvisory[] = [];
      let finalText: string | null = null, parsed: Record<string, unknown> | null = null;
      let cleanup: GenerationCleanup = { local: 'unknown', remote: 'unknown' };
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      let writes: Promise<void> = Promise.resolve();
      const late = (value: LateGenerationEvidence) => { try { onLate?.(value); } catch { /* External evidence failure cannot reopen dispatch. */ } };
      const stop = (why?: string) => {
        error ??= why ?? null;
        if (stopping) return; stopping = true; control.abort();
        if (threadId && turnId && turnStarted && !completed) {
          // Only own server-bound identities. This response never proves process cleanup.
          void transport?.send({ id: 4, method: 'turn/interrupt', params: { threadId, turnId } }).catch(() => undefined);
        }
        try { transport?.close(); } catch { error ??= 'TRANSPORT_CLOSE_FAILED'; }
        resolveDone();
      };
      const accountingSnapshot = (): GenerationOutputAccounting => ({ receivedBytes: receivedTotal, receivedByStream: { ...receivedByStream },
        observedBytes, withheldBytes: observedBytes === null ? null : observedBytes - receivedTotal, status: accountingStatus });
      const rejectAccounting = (code: string) => {
        accountingStatus = 'invalid'; observedBytes = null;
        if (sealed) late({ kind: 'output-accounting', accounting: accountingSnapshot(), error: code });
        else stop(code);
      };
      const onOutputAccounting = (report: { observedBytes: number | null }) => {
        if (!record(report) || Object.keys(report).join(',') !== 'observedBytes' ||
          (report.observedBytes !== null && (!Number.isSafeInteger(report.observedBytes) || report.observedBytes < 0 ||
            report.observedBytes < receivedTotal || (lastKnownObserved !== null && report.observedBytes < lastKnownObserved)))) {
          rejectAccounting('OUTPUT_ACCOUNTING_INVALID'); return;
        }
        // An invalid receipt cannot be repaired by a later apparently valid one.
        if (accountingStatus === 'invalid') {
          if (sealed) late({ kind: 'output-accounting', accounting: accountingSnapshot(), error: 'OUTPUT_ACCOUNTING_INVALID' });
          return;
        }
        observedBytes = report.observedBytes;
        accountingStatus = observedBytes === null ? 'unknown' : 'reported';
        if (observedBytes !== null) lastKnownObserved = observedBytes;
        const accountingError = observedBytes === null ? 'OUTPUT_ACCOUNTING_UNKNOWN' :
          observedBytes > APP_SERVER_GENERATION_LIMITS.outputBytes ? 'OUTPUT_LIMIT' : null;
        if (sealed) { late({ kind: 'output-accounting', accounting: accountingSnapshot(), error: accountingError }); return; }
        if (accountingError) stop(accountingError);
      };
      const send = (frame: Frame) => {
        writes = writes.then(async () => {
          if (stopping || performance.now() >= deadlineAt) { stop('GENERATION_DEADLINE'); return; }
          if (frame.id === 3) turnSent = true;
          await transport!.send(structuredClone(frame));
          if (typeof frame.id === 'number') delivered.add(frame.id);
        }).catch(() => stop('TRANSPORT_WRITE_FAILED'));
      };
      const receive = (frame: unknown) => {
        if (performance.now() >= deadlineAt) fail('GENERATION_DEADLINE');
        if (!record(frame) || 'jsonrpc' in frame) fail('INVALID_FRAME');
        if ('method' in frame) {
          if ('id' in frame) fail('UNSOLICITED_SERVER_REQUEST');
          const keys = Object.keys(frame).sort().join(',');
          if ((keys !== 'method,params' && keys !== 'emittedAtMs,method,params') || !record(frame.params) ||
            ('emittedAtMs' in frame && (!Number.isSafeInteger(frame.emittedAtMs) || (frame.emittedAtMs as number) < 0))) fail('INVALID_NOTIFICATION');
          const p = frame.params;
          if (frame.method === 'configWarning') {
            if (expected === 1 || configurationAdvisories.length !== 0 || Object.keys(p).sort().join(',') !== 'details,summary' ||
              p.summary !== LINUX_SANDBOX_ADVISORY_SUMMARY || p.details !== null) fail('CONFIGURATION_ADVISORY_REJECTED');
            configurationAdvisories.push(Object.freeze({ kind: 'linux-sandbox-user-namespace-unavailable',
              summary: LINUX_SANDBOX_ADVISORY_SUMMARY, details: null,
              ...('emittedAtMs' in frame ? { emittedAtMs: frame.emittedAtMs as number } : {}) }));
            return; // Evidence only; never changes sandbox, policy, readiness or dispatch gates.
          }
          // Pinned turn events are deliberately handled below; all others fail closed.
          handleNotification(frame.method, p);
          return;
        }
        if (Object.keys(frame).sort().join(',') !== 'id,result' || frame.id !== expected || !delivered.has(expected)) fail('INVALID_RESPONSE');
        const result = frame.result;
        if (!record(result)) fail('INVALID_RESULT');
        if (expected === 1) {
          if (typeof result.userAgent !== 'string' || !result.userAgent || result.platformFamily !== 'unix' || result.platformOs !== 'linux' ||
            typeof result.codexHome !== 'string' || !/^\/work\/appserver-home\/fixed-[a-z0-9_]{8}$/.test(result.codexHome)) fail('INITIALIZE_IDENTITY_MISMATCH');
          expected = 2; send({ method: 'initialized', params: {} }); send(threadRequest(request.system));
        } else if (expected === 2) {
          const thread = result.thread;
          if (result.model !== 'gpt-5.6-sol' || result.modelProvider !== 'openai' || result.reasoningEffort !== 'low' || result.cwd !== '/work' ||
            result.approvalPolicy !== 'never' || JSON.stringify(result.runtimeWorkspaceRoots) !== '[]' ||
            !record(result.sandbox) || result.sandbox.type !== 'readOnly' || result.sandbox.networkAccess !== false ||
            !record(thread) || !identity(thread.id) || thread.ephemeral !== true || thread.path !== null) fail('THREAD_PROFILE_MISMATCH');
          if (announcedThread !== null && announcedThread !== thread.id) fail('THREAD_IDENTITY_MISMATCH');
          threadId = thread.id; expected = 3;
          send(turnRequest(threadId, request.user));
        } else if (expected === 3) {
          bindTurn(result.turn); expected = 0;
          if (completed) stop();
        } else fail('UNEXPECTED_RESPONSE');
      };
      // Defined here to keep all identity and lifecycle state local to this invocation.
      const bindTurn = (turn: unknown): void => {
        if (!record(turn) || !identity(turn.id) || turn.status !== 'inProgress' || turn.error !== null || !Array.isArray(turn.items) || turn.items.length) fail('INVALID_TURN_START');
        if (turnId !== null && turnId !== turn.id) fail('TURN_IDENTITY_MISMATCH'); turnId = turn.id;
      };
      const turnRequest = (thread: string, text: string): Frame => ({ id: 3, method: 'turn/start', params: {
        threadId: thread, input: [{ type: 'text', text }], environments: [], model: 'gpt-5.6-sol', effort: 'low',
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [],
      } });
      const handleNotification = (method: unknown, p: Frame): void => {
        if (method === 'remoteControl/status/changed') {
          if (expected === 1 || remoteStatusObserved || Object.keys(p).sort().join(',') !== 'environmentId,installationId,serverName,status' ||
            p.status !== 'disabled' || p.environmentId !== null || typeof p.serverName !== 'string' || !p.serverName.trim() ||
            Buffer.byteLength(p.serverName) > 256 || /[\u0000-\u001f\u007f]/.test(p.serverName) ||
            typeof p.installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.installationId)) fail('REMOTE_CONTROL_STATUS_REJECTED');
          remoteStatusObserved = true; return;
        }
        if (method === 'thread/started') {
          const t = p.thread;
          if (!delivered.has(2) || announcedThread !== null || !record(t) || !identity(t.id) || t.ephemeral !== true || t.path !== null ||
            (threadId !== null && threadId !== t.id)) fail('THREAD_NOTIFICATION_MISMATCH');
          announcedThread = t.id; return;
        }
        if (!delivered.has(3) || !threadId || p.threadId !== threadId) fail('EVENT_THREAD_MISMATCH');
        if (method === 'turn/started') {
          if (turnStarted) fail('DUPLICATE_TURN_START'); bindTurn(p.turn); turnStarted = true; onTurnStart?.(); return;
        }
        if (!turnStarted || !turnId) fail('EVENT_BEFORE_TURN_START');
        if (method === 'turn/completed') {
          const t = p.turn;
          if (completed || !record(t) || t.id !== turnId || t.status !== 'completed' || t.error !== null ||
            !Array.isArray(t.items) || !finalText || Array.from(items.values()).some(item => !item.done)) fail('INVALID_TURN_COMPLETION');
          if (t.items.length) {
            const seen = new Set<string>();
            for (const item of t.items) {
              if (!record(item) || !identity(item.id) || seen.has(item.id)) fail('TERMINAL_ITEMS_MISMATCH');
              seen.add(item.id);
              const prior = completedItems.get(item.id);
              if (!prior || JSON.stringify(prior) !== JSON.stringify(item)) fail('TERMINAL_ITEMS_MISMATCH');
            }
            if (seen.size !== completedItems.size) fail('TERMINAL_ITEMS_MISMATCH');
          }
          const json = strictJson(finalText);
          if (!record(json) || !Object.keys(json).length) fail('INVALID_GENERATION_JSON');
          if (performance.now() >= deadlineAt) fail('GENERATION_DEADLINE');
          parsed = json; completed = true; if (expected === 0) stop(); return;
        }
        if (p.turnId !== turnId || completed) fail('EVENT_TURN_MISMATCH');
        if (method === 'item/started' || method === 'item/completed') {
          const item = p.item;
          if (record(item) && identity(item.id) && item.type === 'userMessage') {
            if (!Array.isArray(item.content) || item.content.length !== 1 || !record(item.content[0]) ||
              item.content[0].type !== 'text' || item.content[0].text !== request.user ||
              (item.clientId !== null && item.clientId !== undefined)) fail('USER_ITEM_MISMATCH');
            const known = items.get(item.id);
            if (method === 'item/started') {
              if (known) fail('DUPLICATE_ITEM'); items.set(item.id, { type: 'userMessage', text: request.user, done: false });
            } else {
              if (!known || known.type !== 'userMessage' || known.done) fail('USER_ITEM_MISMATCH');
              known.done = true; completedItems.set(item.id, structuredClone(item));
            }
            return;
          }
          if (!record(item) || !identity(item.id) || item.type !== 'agentMessage' || typeof item.text !== 'string' ||
            (item.phase !== 'commentary' && item.phase !== 'final_answer' && item.phase !== null && item.phase !== undefined) ||
            (item.memoryCitation !== null && item.memoryCitation !== undefined)) fail('UNSUPPORTED_ITEM');
          const known = items.get(item.id);
          if (method === 'item/started') {
            if (known || item.text !== '') fail('INVALID_ITEM_START');
            items.set(item.id, { type: typeof item.phase === 'string' ? item.phase : 'unknown', text: '', done: false });
          } else {
            if (!known || known.done || (known.type !== 'unknown' && known.type !== item.phase) || known.text !== item.text ||
              (item.phase !== 'commentary' && item.phase !== 'final_answer')) fail('ITEM_COMPLETION_MISMATCH');
            known.done = true;
            completedItems.set(item.id, structuredClone(item));
            if (item.phase === 'final_answer') { if (finalText !== null) fail('MULTIPLE_FINAL_MESSAGES'); finalText = item.text; }
          }
          return;
        }
        if (method === 'item/agentMessage/delta') {
          if (!identity(p.itemId) || typeof p.delta !== 'string') fail('INVALID_DELTA');
          const item = items.get(p.itemId);
          if (!item || item.done || item.type === 'userMessage') fail('DELTA_ITEM_MISMATCH'); item.text += p.delta; return;
        }
        if (method === 'thread/tokenUsage/updated') {
          const usage = p.tokenUsage;
          if (!record(usage)) fail('INVALID_TOKEN_USAGE');
          for (const part of [usage.total, usage.last]) {
            if (!record(part)) fail('INVALID_TOKEN_USAGE');
            for (const key of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
              if (!Number.isSafeInteger(part[key]) || (part[key] as number) < 0) fail('INVALID_TOKEN_USAGE');
            }
            if (part.cacheWriteInputTokens !== undefined && (!Number.isSafeInteger(part.cacheWriteInputTokens) || (part.cacheWriteInputTokens as number) < 0)) fail('INVALID_TOKEN_USAGE');
          }
          if (usage.modelContextWindow !== null && (!Number.isSafeInteger(usage.modelContextWindow) || (usage.modelContextWindow as number) < 0)) fail('INVALID_TOKEN_USAGE');
          return;
        }
        fail('UNKNOWN_NOTIFICATION');
      };
      const onOutput = (stream: 'stdout' | 'stderr', bytes: Uint8Array) => {
        const count = bytes.byteLength;
        if (!Number.isSafeInteger(receivedTotal + count) || (stream !== 'stdout' && stream !== 'stderr')) {
          rejectAccounting('OUTPUT_RECEIVED_ACCOUNTING_INVALID'); return;
        }
        receivedTotal += count; receivedByStream[stream] += count;
        if (sealed) { late({ kind: 'output', bytes: count, sha256: createHash('sha256').update(bytes).digest('hex') }); return; }
        outputBytes += count;
        if (outputBytes > APP_SERVER_GENERATION_LIMITS.outputBytes) { stop('OUTPUT_LIMIT'); return; }
        const block = Buffer.from(bytes); (stream === 'stdout' ? stdout : stderr).push(block);
        if (stream !== 'stdout') return;
        if (stopping) { if (completed && count) error ??= 'OUTPUT_AFTER_TERMINAL'; return; }
        if (performance.now() >= deadlineAt) { stop('GENERATION_DEADLINE'); return; }
        try {
          partial += decoder.decode(block, { stream: true });
          let newline: number;
          while ((newline = partial.indexOf('\n')) >= 0 && !stopping) {
            const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
            receive(strictJson(line));
          }
        } catch (caught) { stop(caught instanceof Error ? caught.message : 'PROTOCOL_ERROR'); }
      };
      const cancelled = () => stop('GENERATION_CANCELLED');
      const deadline = setTimeout(() => stop('GENERATION_DEADLINE'), Math.max(1, deadlineAt - performance.now()));
      signal?.addEventListener('abort', cancelled, { once: true });
      try {
        transport = factory({ onOutput, onOutputAccounting }, control.signal);
        if (stopping) transport.close();
        void transport.cleanup.then(value => {
          const normalized: GenerationCleanup = { local: value?.local === 'confirmed' ? 'confirmed' : 'unknown', remote: value?.remote === 'confirmed' ? 'confirmed' : 'unknown' };
          if (sealed) { late({ kind: 'cleanup', cleanup: normalized }); return; }
          cleanup = normalized;
          if (!stopping) stop(completed ? undefined : 'TRANSPORT_EARLY_EXIT');
        }, () => stop('TRANSPORT_CLEANUP_FAILED'));
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'reality_compiler_generation', version: '1' }, capabilities: { experimentalApi: true } } });
        await done;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([transport.cleanup.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, APP_SERVER_GENERATION_LIMITS.cleanupMs); })]);
        if (timer) clearTimeout(timer);
        if (cleanup.local !== 'confirmed' || cleanup.remote !== 'confirmed') { blocked = true; error ??= 'TERMINATION_UNKNOWN'; }
        try { partial += decoder.decode(); } catch { error ??= 'TRUNCATED_UTF8'; }
        if (!error && (!completed || !finalText || !parsed || partial.length)) error = 'INCOMPLETE_GENERATION';
      } catch { blocked = true; error ??= 'TRANSPORT_FACTORY_FAILED'; stop(); }
      finally {
        const finalAccounting = accountingSnapshot();
        if (finalAccounting.status === 'reported' && finalAccounting.observedBytes !== null && finalAccounting.observedBytes < receivedTotal) rejectAccounting('OUTPUT_ACCOUNTING_INCOMPLETE');
        if (finalAccounting.status === 'reported' && finalAccounting.observedBytes !== null && finalAccounting.observedBytes > receivedTotal) error ??= 'OUTPUT_WITHHELD';
        sealed = true; clearTimeout(deadline); signal?.removeEventListener('abort', cancelled); busy = false;
      }
      return { outcome: error ? 'failed' : 'completed', error, jsonText: error ? null : finalText, json: error ? null : parsed,
        outputBytes, outputAccounting: accountingSnapshot(), wireRaw: Buffer.concat(stdout).toString('utf8'), stderrRaw: Buffer.concat(stderr).toString('utf8'),
        configurationAdvisories: Object.freeze(configurationAdvisories.map(value => Object.freeze({ ...value }))),
        modelCalls: turnSent ? null : 0, observedTurns: turnStarted ? 1 : 0, cleanup, productionReady: false };
    },
  };
}
