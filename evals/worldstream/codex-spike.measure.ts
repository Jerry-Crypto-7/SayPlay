/**
 * **Spike z 5. 9. 2026: umí Codex napsat JEDNU skutečnou emisi?**
 *
 * Není to měřidlo a nesmí se z něj citovat žádná míra — je to jedna věta,
 * jednou. Odpovídá na otázku, kterou `## Phase 2b` v `plans/P15` otevřela:
 * naměřených 22 s platilo pro hračkové schéma, ne pro `{ geometry, shapes,
 * placements, world }`. Než se postaví `T44`, je potřeba vědět, jestli to
 * Codex vůbec unese.
 *
 * **Harness je schválně cizí, ne vlastní.** Všechno kromě emitoru je
 * `driveCreateCase()` z `measure-create.ts`, tedy tatáž cesta, kterou měří
 * `T14` nad placeným modelem. Vlastní zjednodušený průchod by odpověděl na
 * jinou otázku než tu, na které záleží.
 *
 * ⚠ **Pasti volání Codexu, obě naměřené 5. 9. 2026 a obě selhávají tiše:**
 * víceřádkový prompt jako argument předá jen PRVNÍ ŘÁDEK (vrátí `{}`),
 * a bez uzavřeného stdin proces VISÍ, dokud ho někdo nezabije. Proto je
 * kontrakt v souboru, prompt jednořádkový a `stdio[0]` je `ignore`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import type { UpstreamRequest } from '@/model/prompt';
import { createMeshClient } from '@/shape/mesh-client';

import { readCorpus, type CreateCase } from './lock.mjs';
import { driveCreateCase } from './measure-create';

const SESSION_SEED = 4021;

/** Syrové výpisy Codexu, aby se dal parser opravit podle skutečnosti. */
const RAW_DIR = mkdtempSync(join(tmpdir(), 'codex-raw-'));

/**
 * Odpověď z výpisu Codexu.
 *
 * ⚠ **Formát závisí na tom, jestli je stdout terminál — naměřeno 5. 9. 2026.**
 * V terminálu tiskne `codex exec` banner, značku `codex`, tělo a `tokens used`.
 * **Do roury tiskne jen finální zprávu**, tedy holý JSON a nic jiného. První
 * podoba tohohle parseru hledala jen ty značky, takže nad rourou nenašla nic
 * a celý běh se hlásil jako `unavailable` — vypadalo to na selhání modelu,
 * přitom odpověď byla v pořádku.
 *
 * Zkouší se proto obojí, holý JSON napřed.
 */
function answerFrom(output: string): unknown {
  const candidates: string[] = [output];

  const marker = output.lastIndexOf('\ncodex\n');
  if (marker !== -1) {
    const stop = output.indexOf('\ntokens used', marker);
    candidates.push(output.slice(marker + 7, stop === -1 ? undefined : stop));
  }
  const receipt = output.lastIndexOf('\ntokens used');
  if (receipt !== -1) candidates.push(output.slice(receipt));

  for (const raw of candidates) {
    const text = raw.replace(/```(?:json)?/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  throw new Error(`Codex nevrátil JSON. Konec výpisu:\n${output.slice(-600)}`);
}

/**
 * Kde leží `codex.js`, který spouští shim.
 *
 * ⚠ **Na Windows se `codex` spustit NEDÁ a je to past, ne detail.** V PATH je
 * jen `codex.cmd`, tedy dávkový shim; `execFileSync('codex', …)` na něj
 * odpoví `spawnSync codex ENOENT` (naměřeno 5. 9. 2026, první běh tohohle
 * spike). Obejít se to dá `shell: true`, ale tím se celý prompt vydá cmd.exe
 * na rozebrání podle mezer a uvozovek — a prompt je jedna dlouhá věta.
 *
 * Shim dělá `node <prefix>/node_modules/@openai/codex/bin/codex.js %*`, takže
 * nejlevnější správná cesta je zavolat to samé přímo: žádný shell, žádné
 * uvozovky, argumenty jdou do `argv` tak, jak jsou napsané.
 */
function codexEntry(): string {
  const roots = [
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, 'npm'),
    '/usr/local/lib',
    '/usr/lib/node_modules/..',
  ].filter((root): root is string => root !== null);

  for (const root of roots) {
    const candidate = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('codex.js se nenašel — je Codex CLI nainstalovaný globálně?');
}

interface Call {
  readonly systemChars: number;
  readonly userChars: number;
  readonly answerChars: number;
  readonly ms: number;
}

const calls: Call[] = [];

async function codexEmit(request: UpstreamRequest): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-spike-'));
  const contract = join(dir, 'contract.md');
  writeFileSync(
    contract,
    `${request.system}\n\n----\n\n${request.user}\n\n----\n\nOutput ONLY the JSON object described above. No prose, no explanation, no code fences.\n`,
    'utf8',
  );

  const started = Date.now();
  const output = execFileSync(
    process.execPath,
    [
      codexEntry(),
      'exec',
      '--skip-git-repo-check',
      '-c',
      'tools.web_search=false',
      '-c',
      'model_reasoning_effort="medium"',
      `Read the file ${contract} and do exactly what it says. Output only the JSON object, nothing else.`,
    ],
    // `ignore` na stdin je druhá past: bez ní proces čeká na vstup do timeoutu.
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  const ms = Date.now() - started;
  writeFileSync(join(RAW_DIR, `call-${String(calls.length + 1)}.txt`), output, 'utf8');

  const answer = answerFrom(output);
  calls.push({
    systemChars: request.system.length,
    userChars: request.user.length,
    answerChars: JSON.stringify(answer).length,
    ms,
  });
  process.stdout.write(
    `  volání ${String(calls.length)}: ${String(ms)} ms, prompt ${String(request.system.length + request.user.length)} znaků, odpověď ${String(JSON.stringify(answer).length)} znaků\n`,
  );
  return answer;
}

describe('Codex nad jednou skutečnou emisí', () => {
  it(
    'projde větu c01 celým řetězem a řekne, kde skončila',
    async () => {
      const corpus = readCorpus();
      const entry = (corpus.create as CreateCase[])[0];
      if (entry === undefined) throw new Error('korpus je prázdný');

      const grammar = frozenGrammar();
      if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

      const mesh = createMeshClient({ allowMainThread: true });
      process.stdout.write(`\nvěta ${entry.id}: ${entry.prompt}\n`);

      let done;
      try {
        done = await driveCreateCase(entry, {
          emit: codexEmit,
          mesh: mesh.mesh,
          grammar: grammar.value,
          sessionSeed: SESSION_SEED,
        });
      } finally {
        mesh.dispose();
      }

      const total = calls.reduce((sum, call) => sum + call.ms, 0);
      process.stdout.write(
        [
          '',
          `intentValid       ${String(done.intentValid)}`,
          `blueprintValid    ${String(done.blueprintValid)}`,
          `geometryAuthored  ${String(done.geometryAuthored)}`,
          `worldValid        ${String(done.worldValid)}`,
          `certified         ${String(done.certified)}`,
          `kol sebeopravy    ${String(done.rounds)}`,
          `volání Codexu     ${String(calls.length)}`,
          `čas v Codexu      ${String(Math.round(total / 1000))} s`,
          `celá cesta        ${String(Math.round(done.latencyMs / 1000))} s`,
          `selhalo na        ${done.failure === null ? '—' : `${done.failure.stage}: ${done.failure.detail}`}`,
          '',
        ].join('\n'),
      );

      // Spike nic negatuje. Jediné, co se tvrdí, je že běh doběhl a odpověděl.
      expect(calls.length).toBeGreaterThan(0);
    },
    30 * 60_000,
  );
});
