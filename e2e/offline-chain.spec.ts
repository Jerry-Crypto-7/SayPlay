/**
 * Offline řetězec (T17) — oracle celé Phase 3.
 *
 * Protáhne **všech 40 zmrazených odpovědí** pěti stadii (emise → validace →
 * oprava → commit → replay), přehraje výsledek **v prohlížeči** proti běžícímu
 * produkčnímu serveru a ohodnotí ho sémantickým scorerem z T16.
 *
 * **Oracle nečte tutéž cestu jako implementace.** Řetězení hashů se tu počítá
 * znovu, vlastním průchodem přes `sha256(JSON.stringify(...))`, ne přes
 * `chainFailures()` z harnessu; první vstup se váže na `sha256` pole zmrazeného
 * záznamu, tedy na hodnotu z **manifestu**, ne na tu, kterou spočítal běh. Obě
 * čtení se pak porovnávají — shoda dvou nezávislých průchodů je důkaz, shoda
 * implementace se sebou samou ne.
 *
 * **Test je zelený, běh není.** `runOfflineChain` selže na prahu
 * `offlineFulfilledThreshold` a je to **rozhodnutý, naměřený výsledek**, ne vada
 * (`CLAUDE.md`, nedořešené rozpory 4 a 7): do IR se nesahá, korpus se měnit
 * nesmí, takže T17 práh nesplní a report mezery pojmenuje. Test proto asertuje
 * dvě různé věci — **řetěz musí být bezvadný** (tam se nic netoleruje) a
 * **naměřená distribuce je připíchnutá** na hodnoty, které tenhle běh doopravdy
 * vydal, aby se každý pohyb ozval.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  STAGES,
  chainFailures,
  runOfflineChain,
  type ChainReport,
  type StageRecord,
} from '../evals/harness/chain';
import type { TraceInput } from '../src/sim/interpreter';
import type { VerifiableWorld, VerifyResult } from '../src/verify/witness';

test.describe.configure({ mode: 'serial' });

// --- vlastní čtení korpusu, nezávislé na `evals/harness/` --------------------

interface FrozenRecord {
  readonly forPrompt: string;
  readonly branch: 'create' | 'edit';
  readonly baseWorld?: string;
  readonly sha256: string;
  readonly body: unknown;
}

const frozen: readonly FrozenRecord[] = readFileSync('evals/frozen/responses/index.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as FrozenRecord);

interface FrozenContract {
  readonly id: string;
  readonly requirements: readonly { readonly rid: string; readonly kind: string; readonly value?: unknown }[];
}

const contracts: readonly FrozenContract[] = readFileSync('evals/frozen/contracts.v1.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as FrozenContract);

const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// --- běh se spustí jednou a sdílí se; `serial` to drží v pořadí --------------

let cached: ChainReport | null = null;

/**
 * Kolikrát harness sáhl na dopravu. Počítá se **tady**, ne v harnessu:
 * `report.browserReplays` je jeho vlastní účetnictví a doložilo by samo sebe.
 */
let transportCalls = 0;

/**
 * Kolikrát `verify` doopravdy proběhlo **uvnitř prohlížeče**.
 *
 * Odečítá se hned po běhu a na téže stránce, která ho odbavila: Playwright dává
 * každému testu vlastní `page`, takže o tři testy později by tohle počítadlo
 * bylo nulové i po bezvadném běhu.
 */
let pageReplays = -1;

async function chain(page: Page, request: APIRequestContext): Promise<ChainReport> {
  if (cached !== null) return cached;

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith?.verify !== undefined, undefined, { timeout: 60_000 });

  cached = await runOfflineChain({
    async post(path, data) {
      const response = await request.post(path, { data });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status(), body };
    },
    async replay(world, witness) {
      transportCalls += 1;
      return page.evaluate(
        ([doc, trace]) => {
          // Počítadlo žije v paměti prohlížeče. Doprava, která `page.evaluate`
          // obejde a vrátí hotový výsledek, ho nezvedne — a právě to je jediný
          // rozdíl, který zvenčí nejde předstírat.
          const counted = window as unknown as { __replays?: number };
          counted.__replays = (counted.__replays ?? 0) + 1;
          return window.__worldsmith!.verify(doc as VerifiableWorld, trace as TraceInput[]);
        },
        [world, witness] as const,
      ) as Promise<VerifyResult>;
    },
  });
  pageReplays = await page.evaluate(() => (window as unknown as { __replays?: number }).__replays ?? 0);
  return cached;
}

/**
 * Vlastní průchod řetězem. Nesmí volat `chainFailures` — to je ta druhá strana.
 *
 * Poslední podmínka je ta, na které stojí celý smysl řetězení: **identitní smí
 * být jedině `repair`**. Bez ní projde řetěz, ve kterém se všech pět hashů
 * rovná — formálně navazuje a přitom netvrdí, že se cokoli provedlo. Je to
 * nejlevnější podvrh, který review v4 popisuje, a sama návaznost ho nechytí.
 */
function walk(records: readonly StageRecord[], firstInputHash: string): string[] {
  const broken: string[] = [];
  if (records.length !== 5) broken.push(`${records.length} stadií místo 5`);
  records.forEach((record, index) => {
    if (record.stage !== STAGES[index]) broken.push(`pozice ${index} nese ${record.stage}`);
    if (record.order !== index) broken.push(`${record.stage} má order ${record.order}`);
    if (index === 0 && record.inputHash !== firstInputHash) broken.push(`první vstup ${record.inputHash}`);
    if (index > 0 && record.inputHash !== records[index - 1].outputHash)
      broken.push(`${record.stage} navazuje na ${record.inputHash}, ne na ${records[index - 1].outputHash}`);
    if (record.inputHash === record.outputHash && record.stage !== 'repair')
      broken.push(`${record.stage} nic nezměnilo`);
  });
  if (new Set(records.map((record) => record.requestId)).size > 1) broken.push('víc requestId');
  return broken;
}

const byCase = (report: ChainReport, id: string): readonly StageRecord[] =>
  report.records.filter((record) => record.caseId === id);

// ---------------------------------------------------------------------------

test('všech 40 zmrazených záznamů projde pěti stadii, žádné nechybí', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);

  expect(report.cases.map((result) => result.id)).toEqual(frozen.map((record) => record.forPrompt));
  expect(report.records).toHaveLength(frozen.length * STAGES.length);

  // Prostředí se nesmí vydávat za naměřený výsledek: 503, 404 nad dvojicí ani
  // nedosažitelný server nejsou verdikt o modelu.
  expect(report.failures.filter((failure) => failure.kind === 'transport')).toEqual([]);

  for (const record of frozen)
    expect(byCase(report, record.forPrompt).map((entry) => entry.stage), `${record.forPrompt} nemá pět stadií`).toEqual([
      ...STAGES,
    ]);
});

test('řetěz hashů drží a první vstup je zmrazená odpověď z manifestu', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);

  for (const record of frozen) {
    // Dvojí vazba: hash spočítaný tady **a** hodnota zapsaná v manifestu. Kdyby
    // se běh navázal na vlastní výpočet, doložil by jen sám sebe.
    const fromCorpus = sha256(record.body);
    expect(fromCorpus, `${record.forPrompt}: sha256 v korpusu nesedí na vlastní tělo`).toBe(record.sha256);

    const broken = walk(byCase(report, record.forPrompt), fromCorpus);
    expect(broken, `${record.forPrompt}: ${broken.join('; ')}`).toEqual([]);
  }

  // A totéž řečené harnessem. Dva nezávislé průchody, týž výsledek.
  expect(
    report.failures.filter((failure) => ['chain-broken', 'first-hash', 'stage-missing'].includes(failure.kind)),
  ).toEqual([]);
});

test('kontrola řetězení není dekorativní — podvržený záznam ji shodí', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);
  const records = byCase(report, 'C01');
  const firstInputHash = sha256(frozen.find((record) => record.forPrompt === 'C01')!.body);

  expect(walk(records, firstInputHash)).toEqual([]);

  // Podvrh 1 — pět záznamů se správným `requestId`, dopsaných na jednom místě.
  // Návaznost sedí (všechno je týž hash), a přesto se neprovedlo nic.
  const flat = records.map((record, index) => ({ ...record, inputHash: firstInputHash, outputHash: firstInputHash, order: index }));
  expect(walk(flat, firstInputHash).length, 'plochý řetěz prošel').toBeGreaterThan(0);
  expect(chainFailures('C01', flat, firstInputHash).length, 'harness plochý řetěz pustil').toBeGreaterThan(0);

  // Podvrh 2 — pravé hashe, přerušená návaznost uprostřed.
  const cut = records.map((record, index) => (index === 2 ? { ...record, inputHash: firstInputHash } : record));
  expect(walk(cut, firstInputHash).length, 'přerušená návaznost prošla').toBeGreaterThan(0);
  expect(chainFailures('C01', cut, firstInputHash).length).toBeGreaterThan(0);

  // Podvrh 3 — pravý řetěz, ale kotvený k cizí odpovědi.
  const foreign = sha256(frozen.find((record) => record.forPrompt === 'C02')!.body);
  expect(walk(records, foreign).length, 'cizí kotva prošla').toBeGreaterThan(0);
  expect(chainFailures('C01', records, foreign).some((failure) => failure.kind === 'first-hash')).toBe(true);

  // Chybějící stadium, prohozené pořadí a cizí requestId každé zvlášť.
  expect(walk(records.slice(0, 4), firstInputHash).length).toBeGreaterThan(0);
  expect(walk([records[1], ...records.slice(1)], firstInputHash).length).toBeGreaterThan(0);
  expect(walk(records.map((record, index) => (index === 3 ? { ...record, requestId: 'jiné' } : record)), firstInputHash)).toContain(
    'víc requestId',
  );
});

test('replay v prohlížeči dá tentýž hash jako offline předpověď', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);

  // Kontrola polarity první: kdyby se v prohlížeči nepřehrál ani jeden svět,
  // zbytek téhle aserce by byl prázdný. Naměřeno 19 ze 40 — svět se staví jen
  // tam, kde emise prošla snížením do IR, u editace navíc jen po commitnuté `sim`.
  expect(report.browserReplays, 'v prohlížeči se nepřehrál jediný svět').toBe(19);

  // A totéž ze dvou míst, která harness nedrží: kolikrát se sáhlo na dopravu, a
  // kolik `verify` doopravdy proběhlo **uvnitř prohlížeče**. Bez téhle trojice by
  // aserci „prohlížeč = Node" splnila i doprava, která prohlížeč nikdy nezavolá
  // a hash si dopočítá v Node — obě strany rovnosti by pak měl týž počítač.
  expect(transportCalls, 'harness na dopravu vůbec nesáhl').toBe(report.browserReplays);
  expect(pageReplays, 'prohlížeč neprovedl ani jeden replay').toBe(report.browserReplays);

  expect(report.failures.filter((failure) => failure.kind === 'browser-divergence')).toEqual([]);

  const certified = report.cases.filter((result) => result.browserHash !== null);
  expect(certified.length, 'ani jeden replay nedošel do výhry').toBeGreaterThan(0);
  for (const result of certified) expect(result.browserHash, `${result.id}`).toBe(result.offlineHash);
});

test('endpoint a týž řetěz spuštěný vedle si neodporují', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);
  expect(report.failures.filter((failure) => failure.kind === 'pipeline-disagreement')).toEqual([]);
});

test('mechanická oprava se spouští jen na odmítnuté emisi', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);

  for (const result of report.cases) {
    if (result.branch === 'edit') expect(result.repairApplied, `${result.id}`).toEqual([]);
    if (result.stoppedAt === null) expect(result.repairApplied, `${result.id} opravoval platnou emisi`).toEqual([]);
  }

  // Identitní stadium není chybějící stadium: `outputHash` se rovná `inputHash`
  // a záznam v řetězu je.
  const identities = report.records.filter((record) => record.stage === 'repair' && record.inputHash === record.outputHash);
  expect(identities.length).toBeGreaterThan(0);
});

/**
 * Naměřený výsledek — a je to jediná aserce v souboru, která **nedokazuje
 * potrubí, ale měří korpus proti němu**.
 *
 * Čísla nejsou cíl, jsou to hodnoty, které tenhle běh vydal. Připíchnuté jsou
 * proto, aby se každý pohyb ozval; kdyby se braly z běhu, aserce by neříkala nic.
 */
test('sémantický verdikt: běh selže na zmrazeném prahu a mezery jsou pojmenované', async ({ page, request }) => {
  test.setTimeout(300_000);
  const report = await chain(page, request);

  // Vykázání per případ — AC žádá verdikt z T16 pro každý z nich.
  console.log(
    ['', '=== offline chain (T17) ===', ...report.cases.map((result) =>
      `${result.id.padEnd(4)} ${result.branch.padEnd(6)} declared=${result.declared.padEnd(9)} measured=${result.verdict.padEnd(9)} stopped=${String(result.stoppedAt).padEnd(10)} browser=${result.browserReplayed ? 'yes' : 'no '} unmet=${result.unmet.join(',')}`,
    ), `counts=${JSON.stringify(report.counts)} fulfilled=${report.fulfilled}/${report.threshold} browserReplays=${report.browserReplays}`,
      ...report.failures.map((failure) => `FAIL ${failure.kind} ${failure.caseId}: ${failure.detail}`), ''].join('\n'),
  );

  expect(report.threshold).toBe(24);
  expect(report.thresholdMet).toBe(false);
  expect(report.failures.map((failure) => failure.kind)).toContain('threshold');
  expect(report.ok).toBe(false);

  // `ROBUST` a `FULFILLED` odděleně (`evalSet.reportSeparation`) — žádná
  // sloučená míra.
  expect(report.counts.FULFILLED + report.counts.ROBUST + report.counts.NO_FIT + report.counts.FAULT).toBe(40);
  expect(report.counts).toEqual({ FULFILLED: 6, ROBUST: 24, NO_FIT: 4, FAULT: 6 });

  const idsOf = (predicate: (result: ChainReport['cases'][number]) => boolean): string[] =>
    report.cases.filter(predicate).map((result) => result.id);
  const caseOf = (id: string): ChainReport['cases'][number] => report.cases.find((result) => result.id === id)!;

  // --- mezera 1: tvorba dá 4 ze 7 deklarovaných ------------------------------
  expect(frozen.filter((record) => record.branch === 'create').length).toBe(15);
  expect(idsOf((result) => result.branch === 'create' && result.verdict === 'FULFILLED')).toEqual([
    'C01',
    'C02',
    'C04',
    'C06',
  ]);

  // Tři deklarované, které nevyšly — každý z jiného důvodu, a ani jeden není
  // vada potrubí. `C05` nejde snížit do IR (`countInZone` nad zónou ze tří
  // obdélníků), `C08` neprojde svědkem, `C03` doběhne až na konec a padne na
  // jediném požadavku: prohru scorer hledá výhradně ve stopách, které svět sám
  // deklaruje, a žádná z nich do prohry nedojde.
  expect(caseOf('C05').stoppedAt, 'C05 se najednou snížila').toBe('lowering');
  expect(caseOf('C08').stoppedAt, 'C08 najednou prošla svědkem').toBe('witness');
  expect(caseOf('C03').stoppedAt, 'C03 se zlomila dřív, než na požadavku').toBeNull();
  expect(caseOf('C03').unmet, 'C03 padá na něčem jiném než na prohře').toEqual(['C03.r3']);
  expect(contracts.find((contract) => contract.id === 'C03')!.requirements.find((req) => req.rid === 'C03.r3')!.kind).toBe(
    'reachesLose',
  );

  // --- mezera 2: editace dá 2 z 25, protože se většinou vůbec necommitne -----
  const edits = report.cases.filter((result) => result.branch === 'edit');
  expect(edits).toHaveLength(25);
  expect(idsOf((result) => result.branch === 'edit' && result.verdict === 'FULFILLED')).toEqual(['E09', 'E10']);

  const stoppedAt = (stage: string | null): number => edits.filter((result) => result.stoppedAt === stage).length;
  expect(stoppedAt(null), 'commitnutých editací').toBe(8);
  expect(stoppedAt('witness'), 'zastaveno bránou svědka').toBe(9);
  expect(stoppedAt('lowering'), 'nesnížitelný základní svět').toBe(2);
  expect(stoppedAt('apply'), 'patch nešel aplikovat').toBe(4);
  expect(stoppedAt('references'), 'osiřelý odkaz').toBe(2);

  // Obě `lowering` dědí `C05` — tedy tutéž mezeru v IR, ne vlastní vadu.
  for (const id of ['E05', 'E12'])
    expect(frozen.find((record) => record.forPrompt === id)!.baseWorld, `${id} nedědí C05`).toBe('C05');

  // --- mezera 3: `witnessPreserved: false` nemá jak být splněné --------------
  // Není to výsledek běhu, je to vlastnost korpusu — proto se odvozuje ze
  // zmrazených souborů, ne z reportu. Kontrakt žádá, aby starý svědek po úpravě
  // přestal platit; produkční commit ale takový patch odmítne (`certifySim`,
  // `src/app/api/edit/commit.ts`), a nový svědek nemá odkud přijít, protože ani
  // jeden zmrazený patch na `/sim/witness` nesahá.
  const wantsWitnessBroken = contracts
    .filter((contract) => contract.requirements.some((req) => req.kind === 'witnessPreserved' && req.value === false))
    .map((contract) => contract.id);
  expect(wantsWitnessBroken).toHaveLength(17);
  expect(
    frozen.filter((record) => record.branch === 'edit' && JSON.stringify(record.body).includes('/sim/witness')),
    'nějaký patch přece jen svědka přepisuje — rozpor je tím pádem jinde',
  ).toEqual([]);

  // Naměřený dopad: sedm z devíti zastavení na svědkovi je přesně tenhle tvar.
  // Zbylé dvě (`E13`, `E14`) svědka zachovat CHTĚJÍ a stejně tam padnou.
  const brokenSet = new Set(wantsWitnessBroken);
  expect(idsOf((result) => result.stoppedAt === 'witness' && brokenSet.has(result.id))).toHaveLength(7);
});
