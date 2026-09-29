import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, assertNotTrainingDir, priceOf, runQa, worstCaseUsd } from '../qa-astra.mjs';

// Ceny astry z P30A (10 / 50 USD za 1M tokenů) – vstup testu, ne konstanta skriptu.
const PRICES = { inUsdPerMtok: 10, outUsdPerMtok: 50 };
const USAGE = { prompt_tokens: 1500, completion_tokens: 600 };
const VERDICT = {
  recognizedAs: 'cookie', matchesName: true, suggestedName: 'chocolate chip cookie',
  suggestedTags: ['cookie', 'food'], scaleOk: false, replace: false, note: 'far too large',
};

const dirs: string[] = [];
function outDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-astra-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function asset(id: string) {
  return { assetId: id, label: id, tags: [id], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
}

/** Nahraná odpověď Chat Completions; `calls` počítá, kolikrát se zaplatilo. */
function recorded(content: string, usage = USAGE) {
  const calls: unknown[] = [];
  const call = async (body: unknown) => {
    calls.push(body);
    return { choices: [{ message: { content }, finish_reason: 'stop' }], usage };
  };
  return { calls, call };
}

function run(options: Partial<Parameters<typeof runQa>[0]> & { call: Parameters<typeof runQa>[0]['call'] }) {
  return runQa({
    assets: ['a', 'b', 'c', 'd', 'e'].map(asset),
    sheetFor: () => Buffer.from('png'),
    outDir: outDir(),
    capUsd: 100,
    prices: PRICES,
    model: 'gpt-6-astra',
    ...options,
  });
}

describe('qa-astra spend cap', () => {
  it('prices a call from its usage', () => {
    expect(priceOf(USAGE, PRICES)).toBeCloseTo(0.045, 10);
    expect(worstCaseUsd(PRICES)).toBeCloseTo((MAX_INPUT_TOKENS * 10 + MAX_OUTPUT_TOKENS * 50) / 1e6, 10);
  });

  // Volání v téhle skupině stojí přesně nejhorší případ, takže strop kousne
  // na předvídatelném místě.
  const WORST = { prompt_tokens: MAX_INPUT_TOKENS, completion_tokens: MAX_OUTPUT_TOKENS };

  it('stops before the call that could cross the cap, not after', async () => {
    const { calls, call } = recorded(JSON.stringify(VERDICT), WORST);
    const dir = outDir();
    // Strop na dvě nejhorší volání: třetí by ho mohlo přelézt, takže nepadne.
    const cap = worstCaseUsd(PRICES) * 2.5;
    const result = await run({ call, outDir: dir, capUsd: cap });
    const spend = JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8'));
    expect(result.stoppedByCap).toBe(true);
    expect(calls).toHaveLength(2);
    expect(spend.spentUsd + worstCaseUsd(PRICES)).toBeGreaterThan(cap);
    expect(spend.spentUsd).toBeLessThanOrEqual(cap);
  });

  it('makes no call at all when even one worst case does not fit', async () => {
    const { calls, call } = recorded(JSON.stringify(VERDICT));
    const result = await run({ call, capUsd: worstCaseUsd(PRICES) / 2 });
    expect(calls).toHaveLength(0);
    expect(result.stoppedByCap).toBe(true);
  });

  it('keeps the cap across runs through the ledger', async () => {
    const { calls, call } = recorded(JSON.stringify(VERDICT), WORST);
    const dir = outDir();
    const cap = worstCaseUsd(PRICES) * 1.5;
    await run({ call, outDir: dir, capUsd: cap, limit: 1 });
    await run({ call, outDir: dir, capUsd: cap });
    expect(calls).toHaveLength(1);
  });

  it('raises the worst case when a real call costs more than the estimate', async () => {
    const pricey = { prompt_tokens: MAX_INPUT_TOKENS * 3, completion_tokens: MAX_OUTPUT_TOKENS };
    const { calls, call } = recorded(JSON.stringify(VERDICT), pricey);
    // Bez zvednutí by se po prvním volání vešel ještě jeden původní odhad
    // (utraceno + odhad ≤ strop); se zvednutím už ne.
    const cap = priceOf(pricey, PRICES) + worstCaseUsd(PRICES) * 1.2;
    await run({ call, capUsd: cap });
    expect(calls).toHaveLength(1);
  });

  it('respects --limit and skips models that already have a verdict', async () => {
    const { calls, call } = recorded(JSON.stringify(VERDICT));
    const dir = outDir();
    await run({ call, outDir: dir, limit: 2 });
    await run({ call, outDir: dir, limit: 2 });
    expect(calls).toHaveLength(4);
    expect(readdirSync(dir).filter((name) => name !== 'spend.json').sort()).toEqual(['a.json', 'b.json', 'c.json', 'd.json']);
  });
});

describe('qa-astra verdicts', () => {
  it('writes the verdict with the cost of its call', async () => {
    const { call } = recorded(JSON.stringify(VERDICT));
    const dir = outDir();
    await run({ call, outDir: dir, limit: 1 });
    const record = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'));
    expect(record).toMatchObject({ status: 'ok', verdict: VERDICT, model: 'gpt-6-astra' });
    expect(record.costUsd).toBeCloseTo(0.045, 10);
  });

  it('records broken JSON as invalid instead of crashing, and still books the spend', async () => {
    const { call } = recorded('{"recognizedAs": "cookie", ');
    const dir = outDir();
    const result = await run({ call, outDir: dir, limit: 2 });
    expect(result).toMatchObject({ done: 2, invalid: 2 });
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).status).toBe('invalid');
    expect(JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8')).spentUsd).toBeCloseTo(0.09, 10);
  });

  it('records a verdict missing a field as invalid', async () => {
    const { recognizedAs: _dropped, ...partial } = VERDICT;
    const { call } = recorded(JSON.stringify(partial));
    const dir = outDir();
    await run({ call, outDir: dir, limit: 1 });
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).status).toBe('invalid');
  });

  it('never writes under the training data directory', async () => {
    const train = join(process.cwd(), 'evals/play/train/astra');
    expect(() => assertNotTrainingDir(join(process.cwd(), 'evals/play/train'))).toThrow(/training/);
    const { calls, call } = recorded(JSON.stringify(VERDICT));
    await expect(run({ call, outDir: train })).rejects.toThrow(/training/);
    expect(calls).toHaveLength(0);
    expect(existsSync(train)).toBe(false);
  });
});
