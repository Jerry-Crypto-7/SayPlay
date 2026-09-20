/**
 * **Proud z codex CLI — naměřeno 19. 9. 2026, `codex-cli 0.154.0`, `gpt-6-astra@low`.**
 *
 * Rozhodující podkrok T3 (P21): vydává `codex exec --json` rozepsanou odpověď
 * po kouscích, aby se svět mohl stavět z hotových objektů dřív, než model
 * dopíše zbytek? **Nevydává.** Živý běh s dotazem na 12 objektů JSON dal
 * tento proud (čas od spuštění procesu):
 *
 * ```
 * +447 ms    thread.started
 * +471 ms    turn.started
 * +20 813 ms item.completed  agent_message  (celý text, 2 407 B, naráz)
 * +20 829 ms turn.completed  usage
 * ```
 *
 * Mezi `turn.started` a `item.completed` nepřišla jediná událost — žádné
 * `item.started`, žádné `item.updated`, žádná delta. Prostý režim bez `--json`
 * se chová stejně: celý text na stdout v jedné vlně na +20 486 ms. `exec --help`
 * nemá přepínač, který by proud zapnul (`--output-last-message` píše až po
 * konci, `--output-schema` jen tvaruje výsledek). Binárka sice `AgentMessageDelta`
 * nese, ale `exec` je na stdout nepouští.
 *
 * Důsledek pro T3: parser `src/model/partial-emission.ts` zůstává, průběžná
 * stavba z jednoho volání se **nestaví** — kusy světa přicházejí po jednom
 * volání díky rozřezání z T4. Tenhle soubor připíchne dvě věci, které z toho
 * plynou: čtení proudu se opírá jen o `item.completed`, a kdyby CLI někdy
 * začalo delty posílat, čte se dál totéž — rozepsaný text z delty nikdy není
 * odpověď.
 */
import { describe, expect, it } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { upstreamBranch, upstreamConfigFromEnv } from '../upstream';

const CLI_ENV = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'codex-cli',
  WORLDSMITH_MODEL_KEY: 'local-subscription',
  WORLDSMITH_MODEL: 'gpt-6-astra',
  WORLDSMITH_MODEL_EFFORT: 'medium',
  WORLDSMITH_USD_PER_MTOK_OUT: '25',
  WORLDSMITH_USD_PER_MTOK_IN: '5',
} as const;

const PROMPT = 'a lighthouse whose beam is a bridge';
const answer = { placements: [{ stableId: 'lighthouse', at: [0, 0, 0] }] };

const scripts = mkdtempSync(join(tmpdir(), 'fake-codex-stream-'));

/** Skript, který zahraje Codex: čte stdin, tiskne zadané řádky JSONL. */
function fakeCodex(name: string, lines: readonly unknown[]): string {
  const file = join(scripts, `${name}.cjs`);
  writeFileSync(file, [
    "process.stdin.on('data', () => {});",
    "process.stdin.on('end', () => {",
    `  const lines = ${JSON.stringify(lines)};`,
    '  for (const line of lines) process.stdout.write(JSON.stringify(line) + String.fromCharCode(10));',
    '});',
  ].join('\n'));
  return file;
}

async function generateWith(file: string) {
  const previous = process.env.WORLDSMITH_CODEX_JS;
  process.env.WORLDSMITH_CODEX_JS = file;
  try {
    const config = upstreamConfigFromEnv(CLI_ENV);
    if (config === null) throw new Error('testovací prostředí mělo dát platnou konfiguraci');
    return await upstreamBranch(config).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
  } finally {
    if (previous === undefined) delete process.env.WORLDSMITH_CODEX_JS;
    else process.env.WORLDSMITH_CODEX_JS = previous;
  }
}

/** Přesně to, co CLI 0.154.0 posílá: nic mezi `turn.started` a hotovou zprávou. */
const todayStream = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: JSON.stringify(answer) } },
  { type: 'turn.completed', usage: { input_tokens: 15276, output_tokens: 548, reasoning_output_tokens: 0 } },
];

describe('proud z codex CLI bez delt je dnešní chování', () => {
  it('bez jediné průběžné události se odpověď čte z item.completed', async () => {
    const outcome = await generateWith(fakeCodex('today', todayStream));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body).toEqual(answer);
    expect(outcome.usage).toEqual({ inputTokens: 15276, outputTokens: 548 });
  });

  it('kdyby delty někdy přišly, rozepsaný text z nich není odpověď', async () => {
    // Tvar, který binárka zná (`AgentMessageDelta`), ale `exec` ho nepouští.
    // Předpona `{"placements":[{"stableId":"lighthouse","at":[0,0` by se dala
    // dozávorkovat na platný JSON s jinými čísly — právě to se nesmí stát.
    const whole = JSON.stringify(answer);
    const withDeltas = [
      todayStream[0],
      todayStream[1],
      { type: 'item.started', item: { id: 'i0', type: 'agent_message', text: '' } },
      { type: 'item.updated', item: { id: 'i0', type: 'agent_message', text: whole.slice(0, 40) } },
      { type: 'item.updated', item: { id: 'i0', type: 'agent_message', text: whole.slice(0, 55) } },
      todayStream[2],
      todayStream[3],
    ];
    const outcome = await generateWith(fakeCodex('deltas', withDeltas));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body).toEqual(answer);
  });

  it('delta bez hotové zprávy je vadná odpověď, i když se její text dá rozparsovat', async () => {
    // Nejnebezpečnější delta je ta, která se náhodou dá přečíst celá: kdyby ji
    // čtení vzalo za odpověď, postavil by se svět, který model za vteřinu přepíše.
    const cutOff = [
      todayStream[0],
      todayStream[1],
      { type: 'item.updated', item: { id: 'i0', type: 'agent_message', text: '{"placements":[]}' } },
      todayStream[3],
    ];
    const outcome = await generateWith(fakeCodex('cutoff', cutOff));
    expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
  });
});
