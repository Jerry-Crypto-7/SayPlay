/**
 * Tříúpravová relace (T19) — druhé a poslední místo v plánu, které utrácí.
 *
 * T18 změřil tvorbu jedním voláním na svět. Tady se měří to, co jednotahové
 * měření neuvidí: **tři živé úpravy jednoho běžícího světa za sebou.** Základní
 * svět přichází produkční emisní cestou (`POST /api/emit`, zmrazený a zadarmo),
 * každou úpravu vydá skutečný model proti dokumentu, jak vypadá **po předchozím
 * tahu**, a projde produkčním routerem, commitem a verifikátorem svědka.
 *
 * ## Proč to nejde `POST /api/edit`
 *
 * Odůvodnění je celé v hlavičce `evals/harness/session.ts` a je to rozhodnutí
 * uživatele ze 14. 8. 2026: endpoint váže každý zmrazený patch na základní svět
 * otiskem jeho `sim` části, takže po prvním commitu vrátí 404 — řetězení přes
 * něj nejde poskládat. Volají se proto tytéž funkce, které volá on uvnitř sebe.
 *
 * ## Kdy se spouští
 *
 * Nikdy sám od sebe. `EVAL_LIVE=1` je objednávka; bez ní se testy přeskočí a
 * `npm run test:e2e` zůstává zdarma. Objednané měření, které **nejde spustit**,
 * je ale červená, ne ticho — jinak vypadá hotově a čísla nikde nejsou.
 *
 * ## Prahy se sem nepíšou
 *
 * Táž věta jako u `live-chain.spec.ts`: měří se model a ten odpovídá pokaždé
 * jinak. Aserce míří na **vlastnosti běhu** — řetěz drží, kotva je živá, zmrazený
 * korpus se nikde nedotkl, rozpočet se nepřekročil, relace je jeden svět a ne tři.
 * Naměřená čísla jdou do logu; soudí je T21.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { loadEnvConfig } from '@next/env';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { STAGES } from '../evals/harness/chain';
import { PreflightError } from '../evals/harness/live';
import { TURNS_PER_SESSION, editSessions, runEditSessions, type SessionReport } from '../evals/harness/session';
import type { TraceInput } from '../src/sim/interpreter';
import type { VerifiableWorld, VerifyResult } from '../src/verify/witness';

test.describe.configure({ mode: 'serial' });

/** `.env.local` čte Next v serverovém procesu; Playwright běží vedle něj. */
loadEnvConfig(process.cwd());

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

let cached: SessionReport | null = null;
let pageReplays = -1;

async function sessions(page: Page, request: APIRequestContext): Promise<SessionReport> {
  if (cached !== null) return cached;

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith?.verify !== undefined, undefined, { timeout: 60_000 });

  try {
    cached = await runEditSessions({
      env: process.env,
      // Dopravu vybírá allowlist podle tvaru drátu zvoleného modelu, ne tenhle
      // soubor — jinak by přepnutí profilu změnilo model, ale ne cestu k němu.
      provider: 'allowlist',
      transport: {
        async post(path, data) {
          const response = await request.post(path, { data });
          const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          return { status: response.status(), body };
        },
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
      },
    });
  } catch (thrown) {
    if (thrown instanceof PreflightError)
      throw new Error(
        `EVAL_LIVE=1 je nastavené, ale relace nešla spustit. ${thrown.failure.reason}: ${thrown.failure.detail}`,
      );
    throw thrown;
  }

  pageReplays = await page.evaluate(() => (window as unknown as { __replays?: number }).__replays ?? 0);
  return cached;
}

// ---------------------------------------------------------------------------

test('zmrazená sada unese aspoň jednu tříúpravovou relaci', () => {
  // Běží VŽDY, i bez objednávky: kdyby korpus přestal nést tři úpravy na jeden
  // svět, celá úloha by tiše měřila prázdno a testy níž by se jen přeskočily.
  const plans = editSessions();
  expect(plans.length, 'žádný svět ve zmrazené sadě nemá tři editační prompty').toBeGreaterThan(0);
  for (const plan of plans) {
    expect(plan.prompts, plan.baseWorld).toHaveLength(TURNS_PER_SESSION);
    expect(new Set(plan.prompts.map((prompt) => prompt.id)).size, `${plan.baseWorld} opakuje prompt`).toBe(
      TURNS_PER_SESSION,
    );
  }
});

test('tři živé úpravy projdou pěti stadii, každá', async ({ page, request }) => {
  test.skip(!requested, 'živá relace se objednává přes EVAL_LIVE=1 — bez objednávky se neutrácí');
  test.setTimeout(900_000);
  const report = await sessions(page, request);

  expect(report.failures.filter((failure) => failure.kind === 'provider'), 'poskytovatel neodbavil volání').toEqual([]);
  expect(report.turnsRun, 'neodbavil se ani jeden tah').toBeGreaterThan(0);

  for (const session of report.sessions)
    for (const turn of session.turns)
      expect(turn.records.map((record) => record.stage), `${turn.promptId} nemá pět stadií`).toEqual([...STAGES]);
});

test('relace je jeden svět: každý tah se ptá na dokument po tom předchozím', async ({ page, request }) => {
  test.skip(!requested, 'živá relace se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await sessions(page, request);

  // Tohle je celý rozdíl proti sadě nezávislých jednotahových měření. Revize
  // části `sim` je monotónní čítač, který zvedá **commit**, ne model — takže
  // sled revizí je důkaz, že tahy stály na sobě, a ne vedle sebe.
  for (const session of report.sessions) {
    const committed = session.turns.filter((turn) => turn.committed).length;
    const monotone = session.preservation.find((check) => check.rid === 'session.revisionMonotone');
    expect(monotone, `${session.baseWorld}: kontrola revize se vůbec neprovedla`).toBeDefined();
    expect(monotone!.held, `${session.baseWorld}: ${monotone!.detail}`).toBe(true);
    expect(session.preservation.find((check) => check.rid === 'session.entitiesSurvive')!.held, session.baseWorld).toBe(
      true,
    );
    expect(committed, `${session.baseWorld}: víc commitů než tahů`).toBeLessThanOrEqual(session.turns.length);
  }
});

test('kotva je živá odpověď na disku, nikdy zmrazený záznam', async ({ page, request }) => {
  test.skip(!requested, 'živá relace se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await sessions(page, request);

  expect(report.failures.filter((failure) => failure.kind === 'frozen-leak')).toEqual([]);

  for (const session of report.sessions)
    for (const turn of session.turns) {
      expect(frozenHashes.has(turn.rawHash), `${turn.promptId}: kotva je zmrazená odpověď`).toBe(false);
      // Tělo shodné se zmrazeným je nález, ne selhání — ale **jen když je
      // vykázané**. Tichá shoda je pořád ta věc, kvůli které brána vznikla.
      if (frozenHashes.has(turn.bodyHash))
        expect(turn.frozenBodyMatch, `${turn.promptId}: tělo sedí na zmrazený záznam a report o tom mlčí`).not.toBeNull();
      expect(existsSync(turn.responsePath), `${turn.promptId}: odpověď se neuložila`).toBe(true);

      const stored = JSON.parse(readFileSync(turn.responsePath, 'utf8')) as {
        synthetic: boolean;
        branch: string;
        turn: number;
        raw: unknown;
      };
      expect(stored.synthetic, `${turn.promptId}: uložený záznam se tváří jako syntetický`).toBe(false);
      expect(stored.branch).toBe('edit');
      expect(stored.turn, `${turn.promptId}: uložený záznam neví, kolikátý tah to byl`).toBe(turn.index);
      expect(sha256(stored.raw), `${turn.promptId}: kotva nesedí na uložený soubor`).toBe(turn.rawHash);
      expect(turn.records[0].inputHash).toBe(turn.rawHash);
    }

  expect(report.responsesDir).toContain(report.runId);
});

test('řetěz hashů drží a identitní smí být jen oprava', async ({ page, request }) => {
  test.skip(!requested, 'živá relace se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await sessions(page, request);

  for (const session of report.sessions)
    for (const turn of session.turns) {
      turn.records.forEach((record, index) => {
        expect(record.order, `${turn.promptId}/${record.stage}`).toBe(index);
        if (index > 0)
          expect(record.inputHash, `${turn.promptId}/${record.stage} nenavazuje`).toBe(turn.records[index - 1].outputHash);
        if (record.stage !== 'repair')
          expect(record.inputHash === record.outputHash, `${turn.promptId}/${record.stage} nic nezměnilo`).toBe(false);
      });
      expect(new Set(turn.records.map((record) => record.requestId)).size).toBe(1);
    }

  expect(
    report.failures.filter((failure) => ['chain-broken', 'first-hash', 'stage-missing'].includes(failure.kind)),
  ).toEqual([]);
});

test('replay v prohlížeči sedí s Node a doopravdy proběhl v prohlížeči', async ({ page, request }) => {
  test.skip(!requested, 'živá relace se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await sessions(page, request);

  expect(report.failures.filter((failure) => failure.kind === 'browser-divergence')).toEqual([]);
  expect(pageReplays, 'prohlížeč neprovedl ani jeden replay').toBe(report.browserReplays);

  for (const session of report.sessions)
    for (const turn of session.turns.filter((entry) => entry.browserHash !== null))
      expect(turn.browserHash, turn.promptId).toBe(turn.offlineHash);
});

test('běh nepřekročil strop, neúplnost přizná a úspěšnost relace nedopočítává', async ({ page, request }) => {
  test.skip(!requested, 'živá relace se objednává přes EVAL_LIVE=1');
  test.setTimeout(900_000);
  const report = await sessions(page, request);

  const budget =
    report.spentUsd === null
      ? `calls=${report.calls}/${String(report.callCap)} (předplatné, dolary neplatí)`
      : `spent=${report.spentUsd.toFixed(4)}/${(report.capUsd ?? 0).toFixed(2)} USD`;

  console.log(
    [
      '',
      `=== three-edit session (T19) run=${report.runId} model=${report.model} profile=${report.profile} ===`,
      ...report.sessions.flatMap((session) => [
        `${session.baseWorld} passed=${session.passed ? 'yes' : 'no '} aborted=${session.abortedAt ?? '-'}`,
        ...session.turns.map(
          (turn) =>
            `  ${turn.index}. ${turn.promptId.padEnd(4)} ${turn.editClass.padEnd(16)} verdict=${turn.verdict.padEnd(9)} committed=${turn.committed ? 'yes' : 'no '} effect=${turn.behaviour.effect.padEnd(12)} stopped=${String(turn.stoppedAt).padEnd(10)} leaves=${turn.changedLeaves.length} unmet=${turn.unmet.join(',')}`,
        ),
        ...session.preservation
          .filter((check) => !check.held)
          .map((check) => `  LOST ${check.rid} (tah ${check.fromTurn}): ${check.detail}`),
      ]),
      `sessions=${report.sessionsPassed}/${report.sessionsCompleted} rate=${String(report.sessionSuccessRate)} ` +
        `turns=${report.turnsPassed}/${report.turnsRun} rate=${String(report.turnSuccessRate)} ` +
        `independenceEstimate=${String(report.independenceEstimate)} counts=${JSON.stringify(report.counts)}`,
      `${budget} complete=${report.complete}`,
      ...report.frozenBodyMatches.map((match) => `FROZEN-BODY-MATCH ${match.caseId}: ${match.detail}`),
      ...report.failures.map((failure) => `FAIL ${failure.kind} ${failure.caseId}: ${failure.detail}`),
      '',
    ].join('\n'),
  );

  if (report.spentUsd !== null) expect(report.spentUsd).toBeLessThanOrEqual(report.capUsd!);
  else expect(report.calls, 'běh překročil strop počtu volání').toBeLessThanOrEqual(report.callCap!);

  if (!report.complete) {
    expect(report.stoppedReason, 'běh je neúplný a neřekl proč').not.toBeNull();
    expect(report.sessionsCompleted).toBeLessThan(report.sessionsPlanned);
  } else {
    expect(report.sessionsCompleted).toBe(report.sessionsPlanned);
    expect(report.stoppedReason).toBeNull();
  }

  // AC: úspěšnost relace se **měří**, nedopočítává z nezávislosti tahů. Vykazují
  // se obě čísla vedle sebe právě proto, aby byl vidět rozdíl; kdyby si tahy
  // nepřekážely, seděla by na sobě.
  if (report.sessionsCompleted > 0) {
    expect(report.sessionSuccessRate).toBe(report.sessionsPassed / report.sessionsCompleted);
    expect(report.independenceEstimate).toBe(report.turnSuccessRate! ** TURNS_PER_SESSION);
  } else {
    expect(report.sessionSuccessRate, 'žádná relace nedoběhla — nula by lhala o jmenovateli').toBeNull();
  }

  // Tichý no-op je selhání tahu, ne jeho nízké skóre. Tah, který commitnul a
  // chováním se nehnul, nesmí být nikdy vykázaný jako úspěšný.
  for (const session of report.sessions)
    for (const turn of session.turns)
      if (turn.behaviour.effect === 'silent')
        expect(turn.passed, `${turn.promptId}: tichý no-op prošel jako úspěšný tah`).toBe(false);
});
