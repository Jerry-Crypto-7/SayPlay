#!/usr/bin/env node
/**
 * Verdikt astry nad listem modelu (P30D T2): „co to je, sedí jméno, štítky a
 * měřítko?“. Jednorázová kontrola knihovny, ne součást produktu.
 *
 * ```
 * node scripts/assets/qa-astra.mjs --limit 20 --cap-usd 3      pilot
 * node scripts/assets/qa-astra.mjs --cap-usd 80                 celá knihovna
 * ```
 *
 * Konfigurace z prostředí nebo `.env.local` (hodnoty se nikdy netisknou):
 * `WORLDSMITH_FALLBACK_ENDPOINT` (`openai:https://…`), `WORLDSMITH_FALLBACK_KEY`,
 * `WORLDSMITH_FALLBACK_MODEL` (výchozí `gpt-6-astra`) a ceny
 * `WORLDSMITH_FALLBACK_USD_PER_MTOK_IN` / `_OUT`. Cena v kódu není.
 *
 * **Strop drží před voláním, ne po něm.** Každé volání má horní mez útraty
 * (`worstCaseUsd`: strop vstupních tokenů × cena vstupu + `max_completion_tokens`
 * × cena výstupu). Běh skončí, když by utracené + nejhorší případ strop
 * přelezlo – tedy dřív, než se peníze utratí, ne až po překročení.
 *
 * Výstupy astry nesmí do žádné trénovací sady (podmínky OpenAI), proto
 * `assertNotTrainingDir` odmítne zápis pod `evals/play/train/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Horní mez vstupu jednoho volání: list 1024×1024 + záznam katalogu + instrukce. */
export const MAX_INPUT_TOKENS = 4000;
/** Strop výstupu včetně uvažování; delší odpověď je `invalid`, ne dražší. */
export const MAX_OUTPUT_TOKENS = 2000;

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recognizedAs', 'matchesName', 'suggestedName', 'suggestedTags', 'scaleOk', 'replace', 'note'],
  properties: {
    recognizedAs: { type: 'string' },
    matchesName: { type: 'boolean' },
    suggestedName: { type: 'string' },
    suggestedTags: { type: 'array', items: { type: 'string' } },
    scaleOk: { type: 'boolean' },
    replace: { type: 'boolean' },
    note: { type: 'string' },
  },
};

const TRAIN_DIR = resolve(root, 'evals/play/train');

export function assertNotTrainingDir(dir) {
  const full = resolve(dir);
  if (full === TRAIN_DIR || full.startsWith(TRAIN_DIR + sep)) {
    throw new Error(`astra output must never go to training data: ${dir}`);
  }
}

export function priceOf(usage, prices) {
  return (usage.prompt_tokens * prices.inUsdPerMtok + usage.completion_tokens * prices.outUsdPerMtok) / 1e6;
}

export function worstCaseUsd(prices) {
  return priceOf({ prompt_tokens: MAX_INPUT_TOKENS, completion_tokens: MAX_OUTPUT_TOKENS }, prices);
}

export function promptFor(asset) {
  const size = ['x', 'y', 'z'].map((_, axis) => (asset.bounds.max[axis] - asset.bounds.min[axis]).toFixed(2));
  return [
    'You check one 3D model from a game asset library. The image shows it from the front, side, top,',
    'and at 3/4 next to a 1 m cube; its size in metres is written in the corner.',
    'Say what a player would recognise it as, whether the catalogue name fits, which tags a game',
    'designer would search for, whether the real-world size is plausible for the thing it depicts,',
    'and whether the model is too poor to keep (replace). Keep suggestedName short and in English.',
    '',
    `Catalogue name: ${asset.label}`,
    `Catalogue tags: ${asset.tags.join(', ')}`,
    `Size (w x h x d): ${size.join(' x ')} m`,
  ].join('\n');
}

export function requestBody(asset, sheetPng, model) {
  return {
    model,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: { name: 'model_verdict', strict: true, schema: VERDICT_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptFor(asset) },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${sheetPng.toString('base64')}` } },
      ],
    }],
  };
}

/** Odpověď → verdikt, nebo `null`, když tvar neodpovídá schématu. */
export function parseVerdict(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const ok = VERDICT_SCHEMA.required.every((key) => key in value)
    && typeof value.recognizedAs === 'string' && typeof value.matchesName === 'boolean'
    && typeof value.suggestedName === 'string' && Array.isArray(value.suggestedTags)
    && typeof value.scaleOk === 'boolean' && typeof value.replace === 'boolean';
  return ok ? value : null;
}

/**
 * Projde záznamy, na které ještě verdikt není, a zastaví se před voláním,
 * které by mohlo strop přelézt. `call(body)` vrací odpověď Chat Completions.
 */
export async function runQa({ assets, sheetFor, outDir, capUsd, limit = Infinity, prices, model, call, now = () => new Date().toISOString() }) {
  assertNotTrainingDir(outDir);
  mkdirSync(outDir, { recursive: true });
  const ledgerFile = join(outDir, 'spend.json');
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { spentUsd: 0, calls: 0 };
  // Mez z tokenů je odhad (tokeny obrázku počítá poskytovatel); dražší skutečné
  // volání ji zvedne, aby strop držel i nad podhodnoceným odhadem.
  let worst = Math.max(worstCaseUsd(prices), ledger.maxCallUsd ?? 0);
  const result = { done: 0, invalid: 0, stoppedByCap: false, spentUsd: ledger.spentUsd };

  for (const asset of assets) {
    if (result.done >= limit) break;
    const file = join(outDir, `${asset.assetId}.json`);
    if (existsSync(file)) continue;
    if (ledger.spentUsd + worst > capUsd) {
      result.stoppedByCap = true;
      break;
    }
    const response = await call(requestBody(asset, sheetFor(asset), model));
    const usage = response.usage ?? { prompt_tokens: MAX_INPUT_TOKENS, completion_tokens: MAX_OUTPUT_TOKENS };
    const costUsd = priceOf(usage, prices);
    ledger.spentUsd += costUsd;
    ledger.calls += 1;
    ledger.maxCallUsd = Math.max(ledger.maxCallUsd ?? 0, costUsd);
    worst = Math.max(worst, costUsd);
    writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);

    const text = response.choices?.[0]?.message?.content ?? '';
    const verdict = parseVerdict(text);
    const record = { assetId: asset.assetId, label: asset.label, model, at: now(), costUsd, usage };
    if (verdict) Object.assign(record, { status: 'ok', verdict });
    else Object.assign(record, { status: 'invalid', finishReason: response.choices?.[0]?.finish_reason ?? null });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    if (!verdict) result.invalid += 1;
    result.done += 1;
  }
  result.spentUsd = ledger.spentUsd;
  return result;
}

function readEnvLocal() {
  const file = join(root, '.env.local');
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1];
  };
  const env = { ...readEnvLocal(), ...process.env };
  const capUsd = Number(flag('--cap-usd'));
  const limit = flag('--limit') === null ? Infinity : Number(flag('--limit'));
  const prices = { inUsdPerMtok: Number(env.WORLDSMITH_FALLBACK_USD_PER_MTOK_IN), outUsdPerMtok: Number(env.WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT) };
  const endpoint = (env.WORLDSMITH_FALLBACK_ENDPOINT ?? '').trim();
  const key = (env.WORLDSMITH_FALLBACK_KEY ?? '').trim();
  const missing = [
    !(capUsd > 0) && '--cap-usd',
    !(prices.inUsdPerMtok > 0) && 'WORLDSMITH_FALLBACK_USD_PER_MTOK_IN',
    !(prices.outUsdPerMtok > 0) && 'WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT',
    !endpoint.startsWith('openai:') && 'WORLDSMITH_FALLBACK_ENDPOINT=openai:<url>',
    !key && 'WORLDSMITH_FALLBACK_KEY',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`missing: ${missing.join(', ')}`);
    process.exit(2);
  }
  const url = `${endpoint.slice('openai:'.length).replace(/\/+$/, '')}/v1/chat/completions`;
  const sheetDir = flag('--sheets') ?? 'D:/caches/p30d/sheets';
  const assets = JSON.parse(readFileSync(join(root, 'src/assets/catalog.json'), 'utf8')).assets
    .filter((asset) => existsSync(join(sheetDir, `${asset.assetId}.png`)));

  const result = await runQa({
    assets,
    sheetFor: (asset) => readFileSync(join(sheetDir, `${asset.assetId}.png`)),
    outDir: join(root, 'evals/assets/astra-qa'),
    capUsd,
    limit,
    prices,
    model: (env.WORLDSMITH_FALLBACK_MODEL ?? '').trim() || 'gpt-6-astra',
    call: async (body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
      return response.json();
    },
  });
  console.log(`verdicts ${result.done}, invalid ${result.invalid}, spent ${result.spentUsd.toFixed(3)} USD${result.stoppedByCap ? ', stopped by cap' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
