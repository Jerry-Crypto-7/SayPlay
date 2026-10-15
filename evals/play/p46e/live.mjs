/**
 * P46E T6: AI verze naživo na lokálním demu s deseti větami.
 *
 * Nad běžícím `next start` s režisérem na předplatné (proměnné z `.claude/start-demo.cmd`) pošle 8 vět majitele
 * (o01–o08 z `sentences.json`) a 2 nové (mimo zapečetěnou sadu P45), nejvýš dvě naráz (demo má 2 sloty režiséra),
 * u každé čeká na AI verzi a srovná ji s rychlou verzí: `adds` z odpovědi upgradu, pravidla a logika zachované
 * (stejné pravidlo jako `keptOf` v `upgrade.ts`), `aiSec` od POST do konečného stavu upgradu.
 *
 * Strop čekání je 600 s, ne rozpočet 270 s: překročení rozpočtu se zapíše (`overBudget`), ověření se nezkracuje.
 * Semínko je z času běhu, aby žádná věta nenašla AI verzi z dřívějška.
 *
 * Spuštění: `node evals/play/p46e/live.mjs [baseUrl]` (výchozí `http://127.0.0.1:3000`). Zapíše `live.json` vedle sebe.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? process.env.PLAY_BASE_URL ?? 'http://127.0.0.1:3000';
const SLOTS = 2;
const BUDGET_SEC = 270;
const WAIT_CAP_MS = 600_000;
const POLL_EVERY_MS = 3_000;
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

/** Dvě nové věty – ověřeno, že nejsou v `evals/play/p45/sealed-100.json` ani v jiné sadě `evals/`. */
const NEW = [
  { id: 'n01', axis: 'new', text: 'A squirrel collects acorns while hawks dive at it' },
  { id: 'n02', axis: 'new', text: 'A pirate ship sails through a storm firing cannons at sea monsters' },
];

const owner = JSON.parse(readFileSync(here('./sentences.json'), 'utf8')).sentences.filter((row) => /^o0[1-8]$/.test(row.id));
const SENTENCES = [...owner, ...NEW];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET s opakováním při výpadku spojení: první běh 15. 10. ztratil dvě věty na `fetch failed` u dotazu na upgrade
 * (server práci dokončil), klient pustil slot a další věty dostaly „no free play slot“. Opakuje se jen čtení.
 */
async function getJson(path, attempt = 1) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  } catch (thrown) {
    if (attempt >= 5) throw thrown;
    await wait(2_000);
    return getJson(path, attempt + 1);
  }
  return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : await response.text() };
}

/** Ovládání hry bez obalů (`addon_control` → `pacing_control` → … → `steer`); celé `PieceRef` nese i trať. */
const controlOf = (piece) => (piece?.params?.base === undefined ? (piece?.params?.control ?? piece?.id ?? null) : controlOf(piece.params.base));

const hasRules =(spec) => (spec?.rules?.length ?? 0) > 0;
const hasLogic = (spec) => spec?.logic !== undefined;

async function measure(row, seed) {
  const started = Date.now();
  const sec = () => Math.round((Date.now() - started) / 100) / 10;
  const posted = await fetch(`${BASE}/api/play/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: row.text, seed }),
  });
  const created = posted.ok ? await posted.json() : { error: await posted.text() };
  const head = { id: row.id, axis: row.axis, sentence: row.text, seed, ackSec: sec(), quickId: created.versionId ?? null };
  if (!posted.ok || typeof created.versionId !== 'string') return { ...head, status: 'error', reason: `POST ${posted.status}: ${String(created.error).slice(0, 200)}` };
  if (typeof created.upgrade !== 'string') return { ...head, status: 'draft-final', reason: 'NO_UPGRADE_LINK' };

  let status = { status: 'pending' };
  while (Date.now() - started < WAIT_CAP_MS) {
    const polled = await getJson(created.upgrade);
    if (!polled.ok) {
      status = { status: 'error', reason: `upgrade ${polled.status}` };
      break;
    }
    status = polled.body;
    if (status.status !== 'pending') break;
    await wait(POLL_EVERY_MS);
  }
  const aiSec = status.status === 'pending' ? null : sec();
  const out = { ...head, status: status.status, reason: status.reason ?? null, aiSec, overBudget: aiSec === null || aiSec > BUDGET_SEC };
  if (status.status !== 'ready') return out;

  const quick = (await getJson(`/api/play/games/${created.versionId}`)).body;
  const ai = (await getJson(`/api/play/games/${status.versionId}`)).body;
  return {
    ...out,
    aiId: status.versionId,
    aiUrl: `/play/${status.versionId}`,
    adds: status.adds ?? [],
    control: { quick: controlOf(quick.arcade?.control), ai: controlOf(ai.arcade?.control) },
    rules: [quick.spec?.rules?.length ?? 0, ai.spec?.rules?.length ?? 0],
    keptRules: !hasRules(quick.spec) || hasRules(ai.spec),
    keptLogic: !hasLogic(quick.spec) || hasLogic(ai.spec),
    boss: ai.spec?.boss?.name ?? null,
  };
}

const runSeed = (Date.now() % 2_000_000_000) + 1;
const rows = new Array(SENTENCES.length);
let next = 0;
async function slot() {
  while (next < SENTENCES.length) {
    const index = next++;
    const row = SENTENCES[index];
    try {
      rows[index] = await measure(row, runSeed + index);
    } catch (thrown) {
      rows[index] = { id: row.id, axis: row.axis, sentence: row.text, status: 'error', reason: String(thrown) };
    }
    const done = rows[index];
    console.log(`${done.id} ${done.status} ${done.aiSec ?? '-'} s adds=${JSON.stringify(done.adds ?? [])} keptRules=${done.keptRules ?? '-'} ${done.reason ?? ''}`);
  }
}
await Promise.all(Array.from({ length: SLOTS }, slot));

const ready = rows.filter((row) => row.status === 'ready');
const aiSecs = rows.flatMap((row) => (row.aiSec === null || row.aiSec === undefined ? [] : [row.aiSec]));
const report = {
  schema: 'p46e-live-v1',
  measuredAt: new Date().toISOString(),
  baseUrl: BASE,
  director: { endpoint: process.env.WORLDSMITH_MODEL_ENDPOINT ?? 'see server env', slots: SLOTS },
  targets: { ready: '>= 8/10', lostRules: 0, aiSecUnder: BUDGET_SEC, adds: 'waived by owner 15 Oct 2026 (arena has no boss/segments) – recorded only' },
  summary: {
    ready: `${ready.length}/${rows.length}`,
    adds: `${ready.filter((row) => row.adds.length > 0).length}/${ready.length}`,
    lostRules: ready.filter((row) => !row.keptRules).length,
    lostLogic: ready.filter((row) => !row.keptLogic).length,
    maxAiSec: aiSecs.length === 0 ? null : Math.max(...aiSecs),
    overBudget: rows.filter((row) => row.overBudget).map((row) => row.id),
  },
  rows,
};
writeFileSync(here('./live.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report.summary));
