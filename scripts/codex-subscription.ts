import { execFile } from 'node:child_process';
import type { UpstreamRequest } from '../src/model/prompt';

export type Command = (args: string[], input?: string) => Promise<string>;
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
    let offset = 0;
    const referenceSpans = data.text.split('\n').flatMap((line: string) => {
      const startByte = offset, endByte = offset + Buffer.byteLength(line, 'utf8');
      offset = endByte + 1;
      return line.trim() ? [{ sourceId: data.sourceId, startByte, endByte, excerpt: line }] : [];
    });
    return JSON.stringify({ ...data, referenceSpans });
  } catch { return user; }
}
const binary = process.env.CODEX_WSL_BINARY ?? 'codex';
const prefix = ['-d', process.env.CODEX_WSL_DISTRO ?? 'Ubuntu-24.04', '--exec', 'env', '-u', 'OPENAI_API_KEY', '-u', 'CODEX_API_KEY', '-u', 'OPENAI_BASE_URL'];
export const wslCommand: Command = (args, input) => new Promise((resolve, reject) => {
  let seen = '';
  const child = execFile('wsl.exe', [...prefix, ...args], { windowsHide: true, timeout: 200_000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(/usage.limit|rate.limit|quota/i.test(stderr)
      ? 'SUBSCRIPTION_LIMIT' : error.killed || error.code === 124 ? 'CODEX_TIMEOUT' : 'CODEX_COMMAND_FAILED')) : resolve(stdout + (args.includes('status') ? stderr : '')));
  if (!args.includes('status')) child.stdout?.on('data', chunk => {
    seen += String(chunk);
    const lines = seen.split(/\r?\n/); seen = lines.pop() ?? '';
    for (const line of lines) try {
      const event = JSON.parse(line);
      if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type))
        process.stdout.write(`Codex: ${event.type}\n`);
    } catch {}
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input ?? '');
});

export function parseCodexOutput(output: string) {
  const events = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) throw new Error('CODEX_TURN_FAILED');
  const reversed = [...events].reverse();
  const completion = reversed.find(e => e.type === 'turn.completed');
  const message = reversed.find(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  if (!completion || !message) throw new Error('CODEX_INCOMPLETE');
  if (events.some(e => e.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(e.item?.type)))
    throw new Error('CODEX_UNEXPECTED_TOOL');
  const body = JSON.parse(message.item.text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('CODEX_INVALID_JSON');
  return { body, usage: completion.usage ?? null };
}

/** Own local demo only. No HTTP provider, token extraction, API fallback or retries. */
export function subscriptionEmitter(options: {
  workspace: string; command?: Command; maxCalls?: number;
  journal: (event: Record<string, unknown>) => void;
}) {
  const command = options.command ?? wslCommand;
  const maxCalls = options.maxCalls ?? 12;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 60) throw new Error('INVALID_CALL_LIMIT');
  if (!/^\/mnt\/[a-z]\//.test(options.workspace)) throw new Error('WSL_WORKSPACE_REQUIRED');
  let active = false, stopped = false, calls = 0;
  async function checkLogin() {
    const status = await command([binary, 'login', 'status']);
    if (!isChatGPTLogin(status)) throw new Error('CHATGPT_LOGIN_REQUIRED');
  }
  async function generate(request: UpstreamRequest) {
      if (active || stopped || calls >= maxCalls) throw new Error('DEMO_LIMIT');
      active = true;
      let started = false;
      const at = Date.now();
      try {
        await checkLogin();
        const index = ++calls;
        options.journal({ event: 'call-start', index, billing: 'subscription', requestedModel: request.model, reasoningEffort: 'low',
          apiFallback: false, timestamp: new Date(at).toISOString() });
        started = true;
        const output = await command(['timeout', '--signal=TERM', '--kill-after=5s', '180s', binary,
          'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
          '-c', 'model_reasoning_effort="low"',
          '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"',
          '--cd', options.workspace, '--model', request.model, '--json', '-'],
          `${request.system}\n\nReturn only the JSON object, without Markdown. Do not use tools. referenceSpans are mechanically calculated UTF-8 line offsets in the unchanged source; use them for citations when appropriate. They do not establish semantic support.\nSOURCE DATA:\n${citationInput(request.user)}`);
        const result = parseCodexOutput(output);
        options.journal({ event: 'call-end', index, status: 'success', billing: 'subscription',
          wallMs: Date.now() - at, usage: result.usage, usd: null, output: result.body });
        return result;
      } catch (error) {
        stopped = true;
        if (!started) options.journal({ event: 'preflight-failed', billing: 'subscription', inferenceStarted: false,
          wallMs: Date.now() - at, code: error instanceof Error && ['CHATGPT_LOGIN_REQUIRED', 'CODEX_COMMAND_FAILED', 'CODEX_TIMEOUT'].includes(error.message)
            ? error.message : 'SUBSCRIPTION_PREFLIGHT_FAILED' });
        if (started) options.journal({ event: 'call-end', index: calls, status: 'failed', billing: 'subscription',
          wallMs: Date.now() - at, usage: null, usd: null,
          code: error instanceof Error && ['SUBSCRIPTION_LIMIT', 'CODEX_TIMEOUT', 'CODEX_COMMAND_FAILED', 'CODEX_TURN_FAILED', 'CODEX_INCOMPLETE', 'CODEX_UNEXPECTED_TOOL'].includes(error.message)
            ? error.message : 'SUBSCRIPTION_FAILED' });
        throw new Error('SUBSCRIPTION_DEMO_STOPPED');
      } finally { active = false; }
  }
  return {
    checkLogin, generate,
    async emit(request: UpstreamRequest): Promise<unknown> { return (await generate(request)).body; },
  };
}
