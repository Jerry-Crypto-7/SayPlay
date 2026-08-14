/**
 * Živý integrační běh (T18) — jediné místo v celém plánu, které utrácí peníze.
 *
 * Protáhne **skutečný modelový výstup** celým řetězcem proti běžícímu
 * produkčnímu serveru a přehraje výsledek v prohlížeči, přesně jako to dělá
 * `offline-chain.spec.ts` se zmrazenými odpověďmi. Rozdíl je v kotvě: první
 * hash tady patří odpovědi z toho konkrétního volání, uložené do
 * `evals/live/<runId>/responses/`.
 *
 * ## Kdy se spouští, a proč to není `test.skip()` schované pod podmínkou
 *
 * Živý běh se **nespouští sám od sebe**. Musí se vyžádat (`EVAL_LIVE=1`),
 * protože tenhle soubor je jediný v repozitáři, po kterém přijde faktura, a
 * `npm run test:e2e` musí zůstat zdarma.
 *
 * Když se ale **vyžádá a nejde spustit**, je to selhání, ne přeskočení. Ticho
 * na místě, kde si člověk objednal měření, je horší než červená: běh vypadá
 * hotově a naměřená čísla nikde nejsou.
 *
 * ## Prahy se sem nepíšou
 *
 * `offline-chain.spec.ts` má naměřenou distribuci připíchnutou, protože měří
 * **zmrazený** korpus, kde je každá odchylka pohyb v potrubí. Tady se měří
 * model a jeho výstup se mezi běhy liší z podstaty. Připíchnuté číslo by
 * znamenalo test, který zčervená pokaždé, když model odpoví o kousek jinak —
 * tedy oracle na nic. Aserce proto míří na **vlastnosti běhu**: řetěz drží,
 * kotva je živá, zmrazený korpus se nikde nedotkl, rozpočet se nepřekročil.
 * Čísla se vykazují do logu a jejich vyhodnocení patří do T20 a T21.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { loadEnvConfig } from '@next/env';
import { expect, test, type Page } from '@playwright/test';

import { STAGES } from '../evals/harness/chain';
import { PreflightError, runLiveChain, type LiveReport } from '../evals/harness/live';
import { preflight } from '../evals/harness/preflight';
import type { TraceInput } from '../src/sim/interpreter';
import type { VerifiableWorld, VerifyResult } from '../src/verify/witness';

test.describe.configure({ mode: 'serial' });

/**
 * `.env.local` načítá Next.js **v serverovém procesu**, ne v tomhle. Playwright
 * běží vedle, takže bez tohohle řádku by klíč i strop, které tam člověk zapsal
 * podle HALT brány, byly pro harness neviditelné a preflight by pořád hlásil
 * `NO_CREDENTIALS`. Loader je Nextův vlastní, takže platí přesně tatáž pravidla
 * priority souborů jako pro aplikaci — vlastní parser by se s ní rozešel.
 */
loadEnvConfig(process.cwd());

/** Objednávka běhu. Bez ní se neutrácí. */
const requested = process.env.EVAL_LIVE === '1';

const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Hashe zmrazených odpovědí, přečtené **tady** — ne přes harness, který měřím. */
const frozenHashes = new Set(
  readFileSync('evals/frozen/responses/index.jsonl', 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) => {
      const record = JSON.parse(line) as { sha256: string; body: unknown };
      return [record.sha256, sha256(record.body)];
    }),
);

let cached: LiveReport | null = null;
let pageReplays = -1;

async function live(page: Page): Promise<LiveReport> {
  if (cached !== null) return cached;

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith?.verify !== undefined, undefined, { timeout: 60_000 });

  try {
    cached = await runLiveChain({
      env: process.env,
      // Dopravu NEVYBÍRÁME tady. Vybere ji allowlist podle tvaru drátu, který
      // zvolený model mluví — zadrátovat ji sem znamená, že přepnutí profilu
      // v `.env.local` změní model, ale ne cestu, po které se volá.
      provider: 'allowlist',
      async replay(world, witness) {
        return page.evaluate(
          ([doc, trace]) => {
            const counted = window as unknown as { __replays?: number };
            counted.__replays = (counted.__replays ?? 0) + 1;
            return window.__worldsmith!.verify(doc as VerifiableWorld, trace as TraceInput[]);
          },
          [world, witness] as const,
        ) as Promise<VerifyResult>;
      },
    });
  } catch (thrown) {
    // Objednané měření, které nešlo spustit, je červená. Nikdy ticho.
    if (thrown instanceof PreflightError)
      throw new Error(
        `EVAL_LIVE=1 je nastavené, ale živý běh nešel spustit. ${thrown.failure.reason}: ${thrown.failure.detail}`,
      );
    throw thrown;
  }

  pageReplays = await page.evaluate(() => (window as unknown as { __replays?: number }).__replays ?? 0);
  return cached;
}

// ---------------------------------------------------------------------------

test('preflight odmítne běh dřív, než se cokoli utratí', () => {
  // Jediný test v souboru, který běží VŽDY — i bez objednávky a bez klíče.
  // Ověřuje bránu samotnou, ne model, a proto nic nestojí.
  const result = preflight(process.env);
  if (result.ok) {
    // Každý profil se ptá na svůj vlastní strop. Společné je jen to, že
    // nějaký strop mít MUSÍ a že zbytek nesmí být větší než celek.
    if (result.metered) {
      expect(result.capUsd, 'strop musí být kladný').toBeGreaterThan(0);
      expect(result.remainingUsd).toBeLessThanOrEqual(result.capUsd);
    } else {
      expect(result.callCap, 'strop počtu volání musí být kladný').toBeGreaterThan(0);
      expect(result.callsRemaining).toBeLessThanOrEqual(result.callCap);
    }
    return;
  }
  expect(
    [
      'NO_CREDENTIALS', 'NO_MODEL', 'MODEL_NOT_ALLOWED', 'NO_SPEND_CAP', 'INVALID_SPEND_CAP',
      'NO_PRICE', 'INVALID_PRICE', 'CAP_EXHAUSTED', 'NO_CALL_CAP', 'INVALID_CALL_CAP', 'CALL_CAP_EXHAUSTED',
    ],
    'preflight vrátil důvod, který neumí pojmenovat',
  ).toContain(result.reason);
  expect(result.detail.length, 'selhání bez návodu pro člověka').toBeGreaterThan(20);
});

test('živý běh protáhne skutečný modelový výstup pěti stadii', async ({ page }) => {
  test.skip(!requested, 'živý běh se objednává přes EVAL_LIVE=1 — bez objednávky se neutrácí');
  test.setTimeout(900_000);
  const report = await live(page);

  expect(report.failures.filter((failure) => failure.kind === 'provider'), 'poskytovatel neodbavil volání').toEqual([]);
  expect(report.attempted, 'neodbavil se ani jeden prompt').toBeGreaterThan(0);

  for (const result of report.cases)
    expect(result.records.map((record) => record.stage), `${result.id} nemá pět stadií`).toEqual([...STAGES]);
});

test('kotva je živá odpověď na disku, nikdy zmrazený záznam', async ({ page }) => {
  test.skip(!requested, 'živý běh se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await live(page);

  // Tohle je AC celé úlohy: ani jeden živý případ nesmí ukazovat na zmrazený hash.
  expect(report.failures.filter((failure) => failure.kind === 'frozen-leak')).toEqual([]);

  for (const result of report.cases) {
    expect(frozenHashes.has(result.rawHash), `${result.id}: kotva je zmrazená odpověď`).toBe(false);
    expect(frozenHashes.has(result.bodyHash), `${result.id}: tělo je zmrazená odpověď`).toBe(false);

    // Uložený artefakt musí existovat a kotva musí sedět na něj — jinak je
    // běh nedoložitelný zpětně, i kdyby byl bezvadný.
    expect(existsSync(result.responsePath), `${result.id}: odpověď se neuložila`).toBe(true);
    const stored = JSON.parse(readFileSync(result.responsePath, 'utf8')) as { synthetic: boolean; raw: unknown };
    expect(stored.synthetic, `${result.id}: uložený záznam se tváří jako syntetický`).toBe(false);
    expect(sha256(stored.raw), `${result.id}: kotva nesedí na uložený soubor`).toBe(result.rawHash);
    expect(result.records[0].inputHash).toBe(result.rawHash);
  }

  expect(report.responsesDir).toContain(report.runId);
});

test('řetěz hashů drží a identitní smí být jen oprava', async ({ page }) => {
  test.skip(!requested, 'živý běh se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await live(page);

  for (const result of report.cases) {
    const records = result.records;
    records.forEach((record, index) => {
      expect(record.order, `${result.id}/${record.stage}`).toBe(index);
      if (index > 0)
        expect(record.inputHash, `${result.id}/${record.stage} nenavazuje`).toBe(records[index - 1].outputHash);
      if (record.stage !== 'repair')
        expect(record.inputHash === record.outputHash, `${result.id}/${record.stage} nic nezměnilo`).toBe(false);
    });
    expect(new Set(records.map((record) => record.requestId)).size).toBe(1);
  }

  expect(report.failures.filter((failure) => ['chain-broken', 'first-hash', 'stage-missing'].includes(failure.kind))).toEqual(
    [],
  );
});

test('replay v prohlížeči sedí s Node a doopravdy proběhl v prohlížeči', async ({ page }) => {
  test.skip(!requested, 'živý běh se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await live(page);

  expect(report.failures.filter((failure) => failure.kind === 'browser-divergence')).toEqual([]);
  // Počítadlo žije v paměti stránky. Doprava, která prohlížeč obejde, ho nezvedne.
  expect(pageReplays, 'prohlížeč neprovedl ani jeden replay').toBe(report.browserReplays);

  for (const result of report.cases.filter((entry) => entry.browserHash !== null))
    expect(result.browserHash, result.id).toBe(result.offlineHash);
});

test('běh nepřekročil schválený strop a neúplnost přizná', async ({ page }) => {
  test.skip(!requested, 'živý běh se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await live(page);

  const budget =
    report.spentUsd === null
      ? `calls=${report.calls}/${String(report.callCap)} (předplatné, dolary neplatí)`
      : `spent=${report.spentUsd.toFixed(4)}/${(report.capUsd ?? 0).toFixed(2)} USD`;

  console.log(
    ['', `=== live chain (T18) run=${report.runId} model=${report.model} profile=${report.profile} ===`,
      ...report.cases.map((result) =>
        `${result.id.padEnd(4)} verdict=${result.verdict.padEnd(9)} stopped=${String(result.stoppedAt).padEnd(10)} parsed=${result.parsedVia.padEnd(11)} browser=${result.browserReplayed ? 'yes' : 'no '} cost=${result.costUsd === null ? '   n/a ' : result.costUsd.toFixed(5)} unmet=${result.unmet.join(',')}`,
      ),
      `counts=${JSON.stringify(report.counts)} attempted=${report.attempted}/${report.total} ${budget} complete=${report.complete}`,
      ...report.failures.map((failure) => `FAIL ${failure.kind} ${failure.caseId}: ${failure.detail}`), ''].join('\n'),
  );

  if (report.spentUsd !== null)
    expect(report.spentUsd, 'běh přeutratil schválený strop').toBeLessThanOrEqual(report.capUsd!);
  else expect(report.calls, 'běh překročil strop počtu volání').toBeLessThanOrEqual(report.callCap!);

  // Neúplnost není selhání, ale nesmí se zamlčet: useknutý běh vykázaný jako
  // úplný by prošel do statistiky T20 jako plnohodnotná sada.
  if (!report.complete) {
    expect(report.stoppedReason, 'běh je neúplný a neřekl proč').not.toBeNull();
    expect(report.attempted).toBeLessThan(report.total);
  } else {
    expect(report.attempted).toBe(report.total);
    expect(report.stoppedReason).toBeNull();
  }

  // Sémantický verdikt z T16 existuje pro každý odbavený případ.
  expect(report.counts.FULFILLED + report.counts.ROBUST + report.counts.NO_FIT + report.counts.FAULT).toBe(
    report.attempted,
  );
});
