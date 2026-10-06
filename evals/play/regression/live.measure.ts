/**
 * **Jediné živé měření věta → hratelná hra přes celé API (P23-D T6).** Běží jen
 * přes `--config vitest.measure.mts`; `npm test` příponu `.measure.ts` nesbírá.
 *
 * Nad běžícím `next start` (`PLAY_BASE_URL`, výchozí `http://127.0.0.1:3121`)
 * pošle čtyři věty zlatého korpusu – po jedné na `chase_escape`, `collect_exit`,
 * `switch_puzzle` a `delivery` – a měří, co uvidí hráč: potvrzení `POST`,
 * návrh hratelný (`GET` 200) a autorskou verzi od režiséra (poll `upgrade` do
 * `ready`/`draft-final`, strop 180 s). Semínko je z času běhu, aby žádná věta
 * nenašla verzi z dřívějška a čas upgradu byl opravdu čas režiséra.
 *
 * Model volá server, ne tenhle soubor; strop volání drží server
 * (`WORLDSMITH_CALL_CAP`). Bez serveru se **přeskočí s vysvětlením**. Při
 * výpadku se zapíše částečný artefakt s důvodem a neopakuje se.
 */

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { describe, it } from 'vitest';

import { goldenPrompts } from '../golden';

export const PLAY_LIVE_SCHEMA = 'play-live-v1' as const;

const ARCHETYPES = ['chase_escape', 'collect_exit', 'switch_puzzle', 'delivery'] as const;
const UPGRADE_CAP_MS = 180_000;
const POLL_EVERY_MS = 2_000;
const REPORT_FILE = fileURLToPath(new URL('./live.json', import.meta.url));

export interface PlayLiveRow {
  readonly sentence: string;
  readonly ackMs: number;
  readonly draftPlayableMs: number | null;
  readonly upgradeStatus: 'ready' | 'draft-final' | 'pending' | 'error';
  readonly upgradeReason: string | null;
  readonly upgradeMs: number | null;
  readonly source: string | null;
  readonly archetypeDraft: string | null;
  readonly archetypeAuthored: string | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function measure(base: string, sentence: string, seed: number): Promise<PlayLiveRow> {
  const started = performance.now();
  const since = (): number => Math.round(performance.now() - started);
  const posted = await fetch(`${base}/api/play/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence, seed }),
  });
  const ackMs = since();
  const created = await json(posted);
  const empty = { draftPlayableMs: null, upgradeMs: null, source: null, archetypeAuthored: null };
  if (!posted.ok || typeof created.versionId !== 'string') {
    return { sentence, ackMs, ...empty, upgradeStatus: 'error', upgradeReason: `POST ${String(posted.status)}`, archetypeDraft: null };
  }
  const draft = await fetch(`${base}/api/play/games/${created.versionId}`);
  const draftPlayableMs = draft.ok ? since() : null;
  const archetypeDraft = typeof created.archetype === 'string' ? created.archetype : null;
  // Věta, jejíž návrh nejde hrát, čeká na režiséra už v POST – žádný upgrade.
  if (typeof created.upgrade !== 'string') {
    return { sentence, ackMs, ...empty, draftPlayableMs, upgradeStatus: 'draft-final', upgradeReason: 'NO_UPGRADE_LINK', archetypeDraft };
  }

  let status: Record<string, unknown> = { status: 'pending' };
  while (since() < UPGRADE_CAP_MS) {
    const polled = await fetch(`${base}${created.upgrade}`, { cache: 'no-store' });
    if (!polled.ok) {
      status = { status: 'error', reason: `upgrade ${String(polled.status)}` };
      break;
    }
    status = await json(polled);
    if (status.status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
  const upgradeMs = status.status === 'pending' || status.status === 'error' ? null : since();
  let source: string | null = null;
  let archetypeAuthored: string | null = null;
  if (status.status === 'ready' && typeof status.versionId === 'string') {
    const authored = await json(await fetch(`${base}/api/play/games/${status.versionId}`));
    source = ((authored.timings as { source?: string } | undefined)?.source) ?? null;
    archetypeAuthored = ((authored.spec as { archetype?: string } | undefined)?.archetype) ?? null;
  }
  return {
    sentence,
    ackMs,
    draftPlayableMs,
    upgradeStatus: status.status as PlayLiveRow['upgradeStatus'],
    upgradeReason: typeof status.reason === 'string' ? status.reason : null,
    upgradeMs,
    source,
    archetypeDraft,
    archetypeAuthored,
  };
}

describe('sentence to playable game through the whole API, live', () => {
  it('writes live.json, or explains why it skipped', async () => {
    const base = process.env.PLAY_BASE_URL ?? 'http://127.0.0.1:3121';
    try {
      await fetch(`${base}/api/play/games?recent=1`);
    } catch {
      console.warn(`[play] live.measure skipped: no server at ${base} (E2E_PORT=3121 npm run build && npx next start --port 3121, with PLAY_STORE_DIR set to an empty temp dir – otherwise the server answers with games and AI versions saved by an earlier run)`);
      return;
    }

    const corpus = goldenPrompts();
    const rows: PlayLiveRow[] = [];
    let partialReason: string | null = null;
    const runSeed = (Date.now() % 2_000_000_000) + 1;
    for (const [index, archetype] of ARCHETYPES.entries()) {
      const entry = corpus.find((prompt) => prompt.id.endsWith('-1') && prompt.expectArchetype === archetype);
      if (entry === undefined) throw new Error(`golden corpus has no ${archetype}-1 sentence`);
      try {
        const row = await measure(base, entry.prompt, runSeed + index);
        rows.push(row);
        console.warn(`[play] ${archetype}: ack ${String(row.ackMs)} ms, upgrade ${row.upgradeStatus} ${String(row.upgradeMs)} ms (${row.source ?? row.upgradeReason ?? '-'})`);
      } catch (thrown) {
        partialReason = `${archetype}: ${String(thrown)}; later sentences not measured`;
        break;
      }
    }

    const upgraded = rows.flatMap((row) => (row.upgradeMs === null || row.upgradeStatus !== 'ready' ? [] : [row.upgradeMs]));
    const report = {
      schema: PLAY_LIVE_SCHEMA,
      measuredAt: new Date().toISOString(),
      model: process.env.WORLDSMITH_MODEL ?? null,
      baseUrl: base,
      partial: partialReason !== null,
      partialReason,
      rows,
      summary: {
        p50AckMs: median(rows.map((row) => row.ackMs)),
        p50UpgradeMs: median(upgraded),
        authored: `${String(rows.filter((row) => row.source === 'authored').length)}/${String(ARCHETYPES.length)}`,
      },
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  });
});
