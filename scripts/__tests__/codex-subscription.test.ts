import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { moderatePrompt } from '../../src/server/moderation';
import { citationInput, isChatGPTLogin, parseCodexOutput, subscriptionEmitter } from '../codex-subscription';

const output = [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })].join('\n');
describe('subscription-only local demo', () => {
  it('accepts the complete ChatGPT status line with diagnostics but rejects conflicting or partial modes', () => {
    expect(isChatGPTLogin('WARNING: diagnostic\nLogged in using ChatGPT\n')).toBe(true);
    expect(isChatGPTLogin('\u001b[32mLogged in using ChatGPT\u001b[0m\n')).toBe(true);
    expect(isChatGPTLogin('Logged in using ChatGPT\nLogged in using an API key')).toBe(false);
    expect(isChatGPTLogin('Not logged in\nLogged in using ChatGPT')).toBe(false);
    expect(isChatGPTLogin('Example: Logged in using ChatGPT')).toBe(false);
    expect(isChatGPTLogin('Logged in using ChatGPT expired')).toBe(false);
  });
  it('ships a demo source accepted by the real input guard', () => {
    expect(moderatePrompt(readFileSync('evals/reality-compiler/subscription-demo-source.txt', 'utf8')).ok).toBe(true);
  });
  it('provides exact UTF-8 reference offsets without modifying the source', () => {
    const text = 'Žlutá věta.\n\nDruhá věta.\n';
    const result = JSON.parse(citationInput(JSON.stringify({ sourceId: 'source', text })));
    expect(result.text).toBe(text);
    expect(result.referenceSpans).toHaveLength(2);
    for (const span of result.referenceSpans)
      expect(Buffer.from(text).subarray(span.startByte, span.endByte).toString('utf8')).toBe(span.excerpt);
  });
  it('uses stdin, read-only CLI and subscription auth, never an HTTP/API transport', async () => {
    const commands: { args: string[]; input?: string }[] = []; const events: any[] = [];
    const provider = subscriptionEmitter({ workspace: '/mnt/d/demo', journal: e => events.push(e), command: async (args, input) => {
      commands.push({ args, input }); return args.includes('status') ? 'Logged in using ChatGPT\n' : output;
    } });
    expect(await provider.emit({ model: 'requested-model', system: 'instructions', user: '$(do not execute)' })).toEqual({ ok: true });
    expect(commands[1].args).toContain('forced_login_method="chatgpt"');
    expect(commands[1].args).toContain('features.shell_tool=false');
    expect(commands[1].args).toContain('read-only');
    expect(commands[1].args).not.toContain('$(do not execute)');
    expect(commands[1].input).toContain('$(do not execute)');
    expect(events[1]).toMatchObject({ billing: 'subscription', usd: null, usage: { input_tokens: 10 } });
  });
  it('refuses API or missing login before inference', async () => {
    let calls = 0;
    const provider = subscriptionEmitter({ workspace: '/mnt/d/demo', journal: () => {}, command: async () => { calls++; return 'Logged in using an API key'; } });
    await expect(provider.emit({ model: 'm', system: '', user: '' })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('stops after failure and never retries or falls back', async () => {
    let calls = 0; const events: any[] = [];
    const provider = subscriptionEmitter({ workspace: '/mnt/d/demo', journal: e => events.push(e), command: async args => {
      calls++; if (args.includes('status')) return 'Logged in using ChatGPT'; throw new Error('SUBSCRIPTION_LIMIT');
    } });
    await expect(provider.emit({ model: 'm', system: '', user: '' })).rejects.toThrow();
    await expect(provider.emit({ model: 'm', system: '', user: '' })).rejects.toThrow();
    expect(calls).toBe(2); expect(events[1]).toMatchObject({ status: 'failed', usage: null, usd: null });
  });
  it('does not start inference when the journal fails', async () => {
    let calls = 0;
    const provider = subscriptionEmitter({ workspace: '/mnt/d/demo', journal: () => { throw new Error('disk'); },
      command: async () => { calls++; return 'Logged in using ChatGPT'; } });
    await expect(provider.emit({ model: 'm', system: '', user: '' })).rejects.toThrow(); expect(calls).toBe(1);
  });
  it('requires a completed turn and valid JSON, rejects unexpected tool use', () => {
    expect(() => parseCodexOutput('')).toThrow('CODEX_INCOMPLETE');
    expect(() => parseCodexOutput(output.replace('{\\"ok\\":true}', 'not json'))).toThrow();
    expect(() => parseCodexOutput(output + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }))).toThrow('CODEX_UNEXPECTED_TOOL');
  });
  it('enforces the call limit', async () => {
    const provider = subscriptionEmitter({ workspace: '/mnt/d/demo', maxCalls: 1, journal: () => {},
      command: async args => args.includes('status') ? 'Logged in using ChatGPT' : output });
    await provider.emit({ model: 'm', system: '', user: '' });
    await expect(provider.emit({ model: 'm', system: '', user: '' })).rejects.toThrow('DEMO_LIMIT');
  });
});
