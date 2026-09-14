import { execFile } from 'node:child_process';
import type { UpstreamRequest } from '../src/model/prompt';

export type Command = (args: string[], input?: string, signal?: AbortSignal) => Promise<string>;
export function isChatGPTLogin(status: string): boolean {
  // WSL/CLI diagnostics can accompany a successful status on stderr. Match the
  // authoritative complete line, never a substring or a conflicting login mode.
  const lines = status.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim());
  return lines.includes('Logged in using ChatGPT') && !lines.some(line =>
    (line.startsWith('Logged in using ') && line !== 'Logged in using ChatGPT') || /^Not logged in\b/i.test(line));
}
export function citationInput(user: string): string {
  try {
    const data = JSON.parse(user);
    if (typeof data.sourceId !== 'string' || typeof data.text !== 'string') return user;
    const spans = (sourceId: string, text: string) => {
      let offset = 0;
      return text.split('\n').flatMap((line: string) => {
        const startByte = offset, endByte = offset + Buffer.byteLength(line, 'utf8');
        offset = endByte + 1;
        return line.trim() ? [{ sourceId, startByte, endByte, excerpt: line }] : [];
      });
    };
    // Each source has its own byte origin. Supplemental citations never enter
    // the original source's span table, and all source text remains JSON data.
    const supplements = Array.isArray(data.supplements) ? data.supplements.map((source: unknown) => {
      if (!source || typeof source !== 'object' || !('sourceId' in source) || !('text' in source) ||
        typeof source.sourceId !== 'string' || typeof source.text !== 'string') return source;
      return { ...source, referenceSpans: spans(source.sourceId, source.text) };
    }) : undefined;
    return JSON.stringify({ ...data, ...(supplements ? { supplements } : {}), referenceSpans: spans(data.sourceId, data.text) });
  } catch { return user; }
}
// Retained only for the explicitly injected legacy/offline Command protocol.
// Production cannot select an executable or distro through environment overrides.
const binary = 'codex';
function subscriptionLimit(text: string): boolean {
  return /usage[ _.-]?limit|rate[ _.-]?limit|quota|insufficient_quota/i.test(text);
}
function eventFailure(events: any[]): string | undefined {
  const failures = events.filter(e => e?.type === 'turn.failed' || e?.type === 'error');
  if (failures.some(e => subscriptionLimit(JSON.stringify(e)))) return 'SUBSCRIPTION_LIMIT';
  return failures.length ? 'CODEX_TURN_FAILED' : undefined;
}

/** The injectable executable supports offline process fault tests; production always uses WSL. */
export function createSubscriptionCommand(options: {
  executable: string; prefix?: string[]; timeoutMs?: number; maxBuffer?: number;
  progress?: (type: string) => void;
}): Command {
 return (args, input, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('CODEX_CANCELLED')); return; }
  let seen = '';
  let cancelled = false;
  const child = execFile(options.executable, [...(options.prefix ?? []), ...args], {
    windowsHide: true, timeout: options.timeoutMs ?? 200_000, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    signal?.removeEventListener('abort', abort);
    if (cancelled) { reject(new Error('CODEX_CANCELLED')); return; }
    if (!error) { resolve(stdout + (args.includes('status') ? stderr : '')); return; }
    // Quota can be a structured CLI error on stdout. Never classify agent prose
    // as a transport failure, and never expose raw diagnostics in the journal.
    const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    reject(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'CODEX_OUTPUT_LIMIT'
      : subscriptionLimit(stderr) || eventFailure(events) === 'SUBSCRIPTION_LIMIT' ? 'SUBSCRIPTION_LIMIT'
      : error.killed || error.code === 124 ? 'CODEX_TIMEOUT'
      : error.code === 137 ? 'CODEX_PROCESS_KILLED' : 'CODEX_COMMAND_FAILED'));
  });
  // execFile's callback settles after process close. Using its signal option
  // instead would report AbortError before close and falsely imply cleanup.
  // This kills only the direct process: WSL descendants remain unverified.
  const abort = () => { cancelled = true; child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  if (!args.includes('status')) child.stdout?.on('data', chunk => {
    seen += String(chunk);
    const lines = seen.split(/\r?\n/); seen = lines.pop() ?? '';
    for (const line of lines) try {
      const event = JSON.parse(line);
      if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type))
        options.progress?.(event.type);
    } catch {}
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input ?? '');
});
}
/** Fail closed before login/status or process creation. The old wrapper has no
 * validated production sandbox, aggregate limits or owned remote cleanup.
 * A synthetic runtime PASS must not reactivate it. Keep the export for callers
 * while the separately validated fixed dispatcher is being implemented. */
export const wslCommand: Command = async (_args, _input, signal) => {
  if (signal?.aborted) throw new Error('CODEX_CANCELLED');
  throw new Error('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
};

export function parseCodexOutput(output: string) {
  let events: any[];
  try {
    events = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    if (events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) throw new Error();
  } catch { throw new Error('CODEX_INVALID_JSON'); }
  const failure = eventFailure(events);
  if (failure) throw new Error(failure);
  const reversed = [...events].reverse();
  const completion = reversed.find(e => e.type === 'turn.completed');
  const message = reversed.find(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  if (!completion || !message) throw new Error('CODEX_INCOMPLETE');
  if (events.some(e => e.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(e.item?.type)))
    throw new Error('CODEX_UNEXPECTED_TOOL');
  let body: unknown;
  try { body = JSON.parse(message.item.text); } catch { throw new Error('CODEX_INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('CODEX_INVALID_JSON');
  return { body, usage: completion.usage ?? null };
}

/** Own local demo only. No HTTP provider, token extraction, API fallback or retries. */
export function subscriptionEmitter(options: {
  workspace: string; command?: Command; maxCalls?: number;
  journal: (event: Record<string, unknown>) => void;
  now?: () => number;
}) {
  const command = options.command ?? wslCommand;
  const maxCalls = options.maxCalls ?? 12;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 60) throw new Error('INVALID_CALL_LIMIT');
  if (!/^\/mnt\/[a-z]\//.test(options.workspace)) throw new Error('WSL_WORKSPACE_REQUIRED');
  let active = false, stopped = false, calls = 0;
  const now = options.now ?? (() => performance.now());
  async function checkLogin(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('CODEX_CANCELLED');
    const status = await command([binary, 'login', 'status'], undefined, signal);
    if (!isChatGPTLogin(status)) throw new Error('CHATGPT_LOGIN_REQUIRED');
  }
  async function generate(request: UpstreamRequest, signal?: AbortSignal) {
      if (active || stopped || calls >= maxCalls) throw new Error('DEMO_LIMIT');
      active = true;
      let started = false;
      const at = now();
      const timestamp = new Date().toISOString();
      let preflightMs: number | null = null, commandMs: number | null = null, parseMs: number | null = null;
      let commandAt: number | null = null;
      const prompt = `${request.system}\n\nReturn only the JSON object, without Markdown. Do not use tools. referenceSpans are mechanically calculated UTF-8 line offsets in the unchanged source; use them for citations when appropriate. They do not establish semantic support.\nSOURCE DATA:\n${citationInput(request.user)}`;
      try {
        await checkLogin(signal);
        if (signal?.aborted) throw new Error('CODEX_CANCELLED');
        preflightMs = now() - at;
        const index = ++calls;
        options.journal({ event: 'call-start', index, billing: 'subscription', requestedModel: request.model, reasoningEffort: 'low',
          apiFallback: false, timestamp, inputBytes: Buffer.byteLength(prompt, 'utf8'),
          systemBytes: Buffer.byteLength(request.system, 'utf8'), userBytes: Buffer.byteLength(request.user, 'utf8'), preflightMs });
        started = true;
        commandAt = now();
        const output = await command(['timeout', '--signal=TERM', '--kill-after=5s', '180s', binary,
          'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
          '-c', 'model_reasoning_effort="low"',
          '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"',
          '--cd', options.workspace, '--model', request.model, '--json', '-'],
          prompt, signal);
        if (signal?.aborted) throw new Error('CODEX_CANCELLED');
        commandMs = now() - commandAt;
        const parseAt = now();
        const result = parseCodexOutput(output);
        parseMs = now() - parseAt;
        options.journal({ event: 'call-end', index, status: 'success', billing: 'subscription',
          wallMs: now() - at, preflightMs, commandMs, parseMs, outputBytes: Buffer.byteLength(JSON.stringify(result.body), 'utf8'),
          transportOutputBytes: Buffer.byteLength(output, 'utf8'), usage: result.usage, usd: null, output: result.body });
        return result;
      } catch (error) {
        stopped = true;
        if (commandAt !== null && commandMs === null) commandMs = now() - commandAt;
        if (!started) options.journal({ event: 'preflight-failed', billing: 'subscription', inferenceStarted: false,
          wallMs: now() - at, code: error instanceof Error && ['SUBSCRIPTION_PRODUCTION_NOT_VALIDATED', 'CHATGPT_LOGIN_REQUIRED', 'CODEX_COMMAND_FAILED', 'CODEX_TIMEOUT', 'CODEX_OUTPUT_LIMIT', 'CODEX_PROCESS_KILLED', 'SUBSCRIPTION_LIMIT', 'CODEX_CANCELLED'].includes(error.message)
            ? error.message : 'SUBSCRIPTION_PREFLIGHT_FAILED' });
        if (started) options.journal({ event: 'call-end', index: calls, status: 'failed', billing: 'subscription',
          wallMs: now() - at, preflightMs, commandMs, parseMs, usage: null, usd: null,
          code: error instanceof Error && ['SUBSCRIPTION_LIMIT', 'CODEX_TIMEOUT', 'CODEX_OUTPUT_LIMIT', 'CODEX_PROCESS_KILLED', 'CODEX_CANCELLED', 'CODEX_COMMAND_FAILED', 'CODEX_TURN_FAILED', 'CODEX_INCOMPLETE', 'CODEX_INVALID_JSON', 'CODEX_UNEXPECTED_TOOL'].includes(error.message)
            ? error.message : 'SUBSCRIPTION_FAILED' });
        throw new Error('SUBSCRIPTION_DEMO_STOPPED');
      } finally { active = false; }
  }
  return {
    checkLogin, generate,
    async emit(request: UpstreamRequest, signal?: AbortSignal): Promise<unknown> { return (await generate(request, signal)).body; },
  };
}
