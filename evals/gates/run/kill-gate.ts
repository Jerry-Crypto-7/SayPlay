/**
 * Brána §15 — vyhodnocení osmi podmínek nad NAMĚŘENÝM během.
 *
 * Tenhle soubor nic neměří. Měření proběhlo v P1 T21 a leží v
 * `evals/kill-gate-report.json`; tady se z něj skládá zpráva brány. Přeměřovat
 * se nebude (rozhodnutí ze 14. 8. 2026: placené API se nespouští), takže jediná
 * úloha téhle vrstvy je vyhodnotit naměřená čísla proti prahům a nenechat je
 * změkčit.
 *
 * **Čte jen sledované artefakty.** `evals/live/` je v `.gitignore` (repozitář
 * bude veřejný, RULES.md §2), takže nad ním by zpráva na čerstvém klonu
 * nevznikla. Podmínka, jejíž data leží jen tam, se proto vykáže jako
 * `NOT_MEASURED` — ne jako splněná.
 *
 * **Podmínka projde bránou jen když `status === 'MET'` A ZÁROVEŇ je naměřená
 * nad populací tohohle běhu.** Determinismus hashe je dokázaný v jednotkových
 * testech jádra a replay v prohlížeči v T17 — obojí je pravda, ale ani jedno
 * není měření nad kandidáty téhle brány, a vydávat to za splněnou podmínku by
 * bylo přesně to změkčení, které AC úlohy zakazuje.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { statsProtocol, type StatsProtocol } from '../../harness/cluster';
import type { KillGateReport } from '../../harness/kill-gate';

export const GATE_DATE = '2026-09-15';
export const GATE_REPORT_FILE = `kill-gate-${GATE_DATE}.md`;

/**
 * `MET_BELOW_DENOMINATOR` = vlastnost platí, ale na menším jmenovateli, než
 * jaký §15 předepsal. Není to splněná podmínka a nesmí se za ni vydávat; je to
 * samostatný stav, aby se nedal splést ani s `MET`, ani s `NOT_MET`.
 */
export type ConditionStatus = 'MET' | 'MET_BELOW_DENOMINATOR' | 'NOT_MET' | 'NOT_MEASURED';

export interface ConditionVerdict {
  readonly id: string;
  /** Doslovné znění podmínky z DESIGN-BOOK.md §15, „Původní brána". */
  readonly statement: string;
  readonly status: ConditionStatus;
  /** `false` = číslo je odjinud než z kandidátů tohohle běhu. */
  readonly overRunPopulation: boolean;
  /** Co se naměřilo, i s číslem. Nikdy jen „ok". */
  readonly measured: string;
  /** Odkud to číslo je — soubor, běh nebo úloha. */
  readonly evidence: string;
  readonly note: string | null;
}

/** Podmínka započítaná bráně jako splněná. Obojí musí platit současně. */
export function passesGate(verdict: ConditionVerdict): boolean {
  return verdict.status === 'MET' && verdict.overRunPopulation;
}

export interface EightConditions {
  readonly conditions: readonly ConditionVerdict[];
  readonly passed: number;
  readonly required: number;
  readonly allMet: boolean;
}

const CREATE_FLOOR = 0.8;
const EDIT_FLOOR = 0.8;
const PLANNED_ATTEMPTS = 100;
const STRUCTURAL_EDIT_FLOOR = 2;
const STRUCTURAL_EDIT_CLASSES: readonly string[] = ['rule_insert', 'rule_delete'];

function rate(successes: number, trials: number): number | null {
  return trials === 0 ? null : successes / trials;
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1).replace('.', ',')} %`;
}

/**
 * Osm podmínek §15, každá zvlášť. Pořadí je pořadí ze specifikace — zpráva ho
 * nesmí přeskládat, jinak by se dvě čtení nedala porovnat.
 */
export function evaluateConditions(report: KillGateReport): EightConditions {
  const create = report.cases.filter((c) => c.branch === 'create');
  const edit = report.cases.filter((c) => c.branch === 'edit');
  const createAccepted = create.filter((c) => c.accepted);
  const editAccepted = edit.filter((c) => c.accepted);
  const acceptedTotal = createAccepted.length + editAccepted.length;

  // `Outcome.record` je z principu `unknown` — agregát drží surový záznam obou
  // větví a jeho tvar zná až tahle vrstva. Čte se z něj jediné pole a jen tehdy,
  // když tam skutečně je; chybějící `accepted` je nepřijatý, ne výjimka.
  const isAccepted = (record: unknown): boolean =>
    typeof record === 'object' && record !== null && (record as { accepted?: unknown }).accepted === true;

  const structuralEdits = report.perClassFloors
    .filter((cls) => STRUCTURAL_EDIT_CLASSES.includes(cls.classId))
    .flatMap((cls) => cls.members)
    .filter((m) => isAccepted(m.record));

  const createRate = rate(createAccepted.length, create.length);
  const editRate = rate(editAccepted.length, edit.length);
  const createRejected = create.filter((c) => !c.accepted).map((c) => c.id);

  const conditions: readonly ConditionVerdict[] = [
    {
      id: 'createCertified',
      statement: '≥ 8/10 promptů na tvorbu dá certifikovaný hratelný graf',
      status: createRate !== null && createRate >= CREATE_FLOOR ? 'MET' : 'NOT_MET',
      overRunPopulation: true,
      measured: `${createAccepted.length}/${create.length} = ${pct(createRate)} proti prahu ${pct(CREATE_FLOOR)}`,
      evidence: `evals/kill-gate-report.json, běh ${report.run.createRunId}`,
      note:
        'Přijetí = prošel certifikací produkčního endpointu, tedy včetně svědka, který dojde do výhry. ' +
        `Neprošly: ${createRejected.join(', ') || 'žádný'}.`,
    },
    {
      id: 'editAppliedWithoutReset',
      statement: '≥ 8/10 úprav se aplikuje na běžící svět bez resetu',
      status: editRate !== null && editRate >= EDIT_FLOOR ? 'MET' : 'NOT_MET',
      overRunPopulation: true,
      measured: `${editAccepted.length}/${edit.length} = ${pct(editRate)} proti prahu ${pct(EDIT_FLOOR)}`,
      evidence: `evals/kill-gate-report.json, běh ${report.run.editRunId}`,
      note:
        'Transakční patch bez resetu je vlastnost potrubí a drží; co neprojde, zastaví brána svědka nebo ' +
        'neaplikovatelný patch. Viz rozpor 8 v CLAUDE.md — 17 z 25 zmrazených kontraktů žádá, aby starý ' +
        'svědek přestal platit, a produkční commit takový patch odmítne.',
    },
    {
      id: 'witnessWinsInBrowser',
      statement: 'každý přijatý kandidát má svědka, který dojde do výhry v prohlížečovém runtimu',
      status: 'NOT_MEASURED',
      overRunPopulation: false,
      measured:
        `${acceptedTotal}/${acceptedTotal} přijatých má svědka do výhry v Node — přijetí to vyžaduje. ` +
        'V prohlížeči nad touhle populací neměřeno.',
      evidence: 'P1 T17 (commit d608386): 19 replayů v prohlížeči nad zmrazeným řetězcem, všechny sedí s Node',
      note:
        'T17 dokazuje, že prohlížečový runtime dá tentýž hash jako Node — ale nad zmrazeným korpusem, ne nad ' +
        'kandidáty tohohle běhu. Podmínka §15 mluví o přijatých kandidátech brány, takže se nevykazuje jako splněná.',
    },
    {
      id: 'seedHashIdentity',
      statement: 'dva běhy se stejným seedem dají identický hash koncového stavu',
      status: 'MET',
      overRunPopulation: false,
      measured: 'jednotkové testy jádra zelené; T17 navíc 19/19 shod hashe prohlížeč vs. Node',
      evidence: 'src/sim/__tests__/determinism.test.ts, src/sim/__tests__/interpreter.test.ts, P1 T17',
      note:
        'Vlastnost interpretu, ne emise modelu — proto ji tenhle běh neměří a bráně se nezapočítává. ' +
        'Dokázaná je, ale nad jinou populací.',
    },
    {
      id: 'noUncertifiedCommitted',
      statement: 'napříč 100 automatickými pokusy se nezacommituje jediný necertifikovaný kandidát',
      status:
        report.structuralContract.meetsFloor !== true
          ? 'NOT_MET'
          : report.completedCases >= PLANNED_ATTEMPTS
            ? 'MET'
            : 'MET_BELOW_DENOMINATOR',
      overRunPopulation: true,
      measured:
        `${report.structuralContract.clean}/${report.structuralContract.accepted} přijatých bez strukturální ` +
        `vady = ${pct(report.structuralContract.rate)}, ale jen přes ${report.completedCases} pokusů ` +
        `z ${PLANNED_ATTEMPTS}`,
      evidence: 'evals/kill-gate-report.json → structuralContract',
      note:
        'Vlastnost drží bez výjimky, jmenovatel ne. Sto pokusů je v §15 součást podmínky, ne dekorace — ' +
        'nula porušení z 27 a nula ze 100 nejsou totéž tvrzení.',
    },
    {
      id: 'threeDistinctTopologies',
      statement: 'výstupy obsahují ≥ 3 materiálně odlišné topologie a žádný skrytý selektor archetypů',
      status: 'NOT_MEASURED',
      overRunPopulation: false,
      measured: 'neměřeno — sledovaný report nenese topologii emitovaných světů',
      evidence: 'evals/live/* je v .gitignore (RULES.md §2, repozitář bude veřejný)',
      note:
        'Odpovědi modelu leží mimo strom, takže by zpráva na čerstvém klonu nešla znovu složit. Doměřit to jde ' +
        'jedině tak, že se topologická charakteristika dopočítá do sledovaného reportu — to je zásah do P1 T21 ' +
        'a tahle úloha ho nedělá.',
    },
    {
      id: 'twoStructuralEdits',
      statement: '≥ 2 úpravy přidají nebo odeberou podmínku, akci či přechod — ne pouhou změnu parametru',
      status: structuralEdits.length >= STRUCTURAL_EDIT_FLOOR ? 'MET' : 'NOT_MET',
      overRunPopulation: true,
      measured:
        `přijatých úprav ve třídách ${STRUCTURAL_EDIT_CLASSES.join(' + ')}: ${structuralEdits.length} ` +
        `(${structuralEdits.map((m) => m.id).join(', ') || 'žádná'}) proti prahu ${STRUCTURAL_EDIT_FLOOR}`,
      evidence: 'evals/kill-gate-report.json → perClassFloors',
      note:
        'Jediná z osmi podmínek, která projde nad populací tohohle běhu. Třída je čtená ze zmrazeného protokolu, ' +
        'ne odvozená z toho, co model poslal.',
    },
    {
      id: 'flagshipHookFiveTimes',
      statement: 'vlajkový hook funguje 5× po sobě z čisté relace prohlížeče',
      status: 'NOT_MEASURED',
      overRunPopulation: false,
      measured: 'neměřeno — offline řetězec vlajkový hook nespouští',
      evidence: 'žádný artefakt; potřebuje nasazenou adresu (P2 T205b)',
      note: 'Do doby, než adresa existuje, tuhle podmínku nemá co změřit.',
    },
  ];

  const passed = conditions.filter(passesGate).length;
  return { conditions, passed, required: conditions.length, allMet: passed === conditions.length };
}

// ---------------------------------------------------------------------------
// Vykreslení zprávy
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ConditionStatus, string> = {
  MET: 'SPLNĚNO',
  MET_BELOW_DENOMINATOR: 'PLATÍ, ALE POD JMENOVATELEM',
  NOT_MET: 'NESPLNĚNO',
  NOT_MEASURED: 'NEZMĚŘENO',
};

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function rateRow(block: KillGateReport['rawPatchPassRate']): string {
  const w = block.wilson;
  const interval = w === null ? 'n/a' : `${pct(w.lower)} – ${pct(w.upper)}`;
  const floor = block.floor === null ? '—' : pct(block.floor);
  const verdict = block.meetsFloor === null ? '—' : block.meetsFloor ? 'splněno' : '**nesplněno**';
  return `| \`${block.id}\` | ${block.successes}/${block.trials} | ${pct(block.rate)} | ${interval} | ${floor} | ${verdict} |`;
}

function classRow(cls: KillGateReport['perClassFloors'][number], protocol: StatsProtocol): string {
  const gated = cls.trials >= protocol.minDenominatorForFloor;
  return (
    `| \`${cls.classId}\` | ${cls.successes}/${cls.trials} | ${pct(cls.rate)} | ${pct(cls.floor)} | ` +
    `${gated ? 'ano' : `ne — jmenovatel ${cls.trials} < ${protocol.minDenominatorForFloor}`} |`
  );
}

interface DivergenceLock {
  readonly status: string;
  readonly statusReason: string;
}

/**
 * Zámek metriky divergence z T703. Zpráva ho nečte kvůli číslům — čte ho proto,
 * že si sám předepisuje, aby zpráva brány napsala nahlas, že ho nikdo nepoužívá.
 */
function divergenceLock(root: string): DivergenceLock {
  return JSON.parse(
    readFileSync(join(root, 'evals', 'gates', 'divergence.lock.json'), 'utf8'),
  ) as DivergenceLock;
}

export function renderGateReport(
  report: KillGateReport,
  protocol: StatsProtocol = statsProtocol(),
  root: string = process.cwd(),
): string {
  const eight = evaluateConditions(report);
  const clustered = report.clustered.interval;
  const divergence = divergenceLock(root);
  const editCount = report.cases.filter((c) => c.branch === 'edit').length;

  const lines: readonly string[] = [
    `# Kill gate ${GATE_DATE} — zpráva brány`,
    '',
    '> **Generováno.** Zdrojem je `evals/kill-gate-report.json`; tenhle soubor se needituje ručně —',
    '> `evals/gates/run/kill-gate.ts` ho přepíše a test drží disk shodný s vykreslením.',
    '',
    '## Razítko běhu — čti dřív než kterékoli číslo',
    '',
    `- **Grade: \`${report.gate.grade}\`**, profily: ${report.gate.profiles.map((p) => `\`${p}\``).join(', ')}`,
    `- **Citovatelné: ${report.gate.headlineClaimable ? 'ANO' : 'NE'}** — ${report.gate.reason}`,
    '- Žádná míra z téhle zprávy nesmí do přihlášky, reportu ani na web jako výsledek brány.',
    '',
    '## Jmenovatel — plánovaný a skutečný',
    '',
    `§15 předepsal **20 světů × 5 sekvenčních úprav = ${PLANNED_ATTEMPTS} editačních tahů**, vyvážených přes sedm tříd.`,
    `Skutečný běh dodal **${report.completedCases} případů nad ${report.corpus.clusters} světy** — ` +
      `harness jich naplánoval ${report.plannedCases} a doběhly všechny (\`complete: ${report.complete}\`). ` +
      `Sto tahů §15 se tím ale nedodalo: jsou to **editační** tahy a editační větev jich má ${editCount}.`,
    '',
    '**Nesplněný jmenovatel je sám o sobě nález** a uvádí se vedle každé míry, ne pod čarou.',
    '',
    '## Agregátní míry',
    '',
    '| Míra | Zlomek | Bod | Wilson 95 % | Práh | Verdikt |',
    '|---|---:|---:|---:|---:|---|',
    rateRow(report.rawPatchPassRate),
    rateRow(report.firstRequestCommitRate),
    rateRow(report.fulfilledRate),
    '',
    `**Shlukování.** Případy nejsou nezávislé — leží uvnitř ${report.corpus.clusters} světů. Clusterovaný interval: ` +
      `**${pct(report.clustered.rate)} [${pct(clustered.lower)}, ${pct(clustered.upper)}]** ` +
      `(${clustered.resamples} převzorkování, seed ${clustered.seed}).`,
    '',
    `> ${report.wilsonCaveat}`,
    '',
    '**Holé procento se tu neuvádí nikde** — vždy bod, mez a poznámka o shlukování.',
    '',
    '## Strukturální kontrakt',
    '',
    `Přijato ${report.structuralContract.accepted}, bez vady ${report.structuralContract.clean} = ` +
      `**${pct(report.structuralContract.rate)}** proti prahu ${pct(report.structuralContract.floor)} → ` +
      `${report.structuralContract.meetsFloor ? 'splněno' : '**nesplněno**'}.`,
    '',
    `> ${report.structuralContract.notARate}`,
    '',
    '## Tříúpravová relace — měřená přímo',
    '',
    `Relace: **${report.threeEditSession.sessionsPassed}/${report.threeEditSession.sessionsCompleted}** ` +
      `(plánováno ${report.threeEditSession.sessionsPlanned}), tahy ` +
      `**${report.threeEditSession.turnsPassed}/${report.threeEditSession.turnsRun}**.`,
    `Dopočet z nezávislosti tahů by dal ${pct(report.threeEditSession.independenceEstimate)} — vykazuje se vedle ` +
      'naměřené hodnoty právě proto, že se používat nesmí.',
    '',
    `> ${report.threeEditSession.contrastNote}`,
    '',
    '## Podlahy po třídách úprav',
    '',
    'Podlahy jsou ze zmrazeného protokolu (`evals/frozen/protocol.v1.json`, zmrazeno 2026-08-12 — tedy před ' +
      'během ze 14. 8.). Podlahy z tabulky v `plans/P7-brany-a-evaluace.md` (90 / 85 / 75 a druhý sloupec pro ' +
      '`firstRequestCommitRate`) zmrazené **nejsou** a bráně nevládnou.',
    '',
    '| Třída | Zlomek | Bod | Zmrazená podlaha | Hradí? |',
    '|---|---:|---:|---:|---|',
    ...report.perClassFloors.map((cls) => classRow(cls, protocol)),
    '',
    `**Žádná třída nehradí.** Zmrazený protokol žádá jmenovatel nejméně ${protocol.minDenominatorForFloor} tahů ` +
      `na třídu; skutečné jmenovatele jsou ${report.perClassFloors.map((c) => c.trials).join(', ')}. Tvrdit ` +
      'splněnou nebo porušenou třídní podlahu na jednom až třech tazích znamená soudit šum, a to je přesně ta ' +
      'chyba, před kterou zmrazený protokol varuje sám (`perClassFloorEnforcement`).',
    '',
    '## Zamčená metrika divergence — zamčená, nepoužitá, a je to tak správně',
    '',
    `Zámek \`evals/gates/divergence.lock.json\` se sám hlásí jako \`${divergence.status}\`.`,
    `> ${divergence.statusReason}`,
    '',
    'Odběratelem byla scénová brána 13. 10. (P5 T504). P5 je od 15. 8. 2026 zrušený, takže zámek dnes nikdo' +
      ' nečte a v téhle zprávě se nepoužívá k ničemu. Zůstává schválně: oracle bez odběratele je pořád zámek' +
      ' proti tomu, aby si ho někdo zítra napsal sám podle výsledku.',
    '',
    '## Osm podmínek §15 — každá zvlášť, všechny povinné',
    '',
    '| # | Podmínka | Stav | Naměřeno | Nad populací běhu |',
    '|---:|---|---|---|---|',
    ...eight.conditions.map(
      (c, i) =>
        `| ${i + 1} | ${cell(c.statement)} | **${STATUS_LABEL[c.status]}** | ${cell(c.measured)} | ` +
        `${c.overRunPopulation ? 'ano' : 'ne'} |`,
    ),
    '',
    ...eight.conditions.flatMap((c, i) => [
      `**${i + 1}. \`${c.id}\`** — ${STATUS_LABEL[c.status]}. Zdroj: ${c.evidence}.`,
      ...(c.note === null ? [] : [c.note]),
      '',
    ]),
    '## Verdikt',
    '',
    `**Brána padá.** Bráně se započítává ${eight.passed} z ${eight.required} podmínek — podmínka projde jedině ` +
      'tehdy, když je splněná **a zároveň** naměřená nad kandidáty tohohle běhu.',
    '',
    `Agregátní míry padají obě: \`rawPatchPassRate\` ${pct(report.rawPatchPassRate.rate)} proti prahu ` +
      `${pct(report.rawPatchPassRate.floor)} a \`firstRequestCommitRate\` ` +
      `${pct(report.firstRequestCommitRate.rate)} proti prahu ${pct(report.firstRequestCommitRate.floor)}.`,
    '',
    '**Co z toho drží a je doložené:** strukturální kontrakt 100 %, nic vadného neprojde přijetím, replay ' +
      'v prohlížeči sedí s Node, řetěz hashů je bezvadný a editace běžícího světa funguje bez resetu. To je teze ' +
      'o determinismu, ne o spolehlivosti emise — a tak se taky vykazuje.',
    '',
  ];

  return `${lines.join('\n')}\n`;
}

export function killGateReportFile(root: string = process.cwd()): string {
  return join(root, 'evals', 'gates', GATE_REPORT_FILE);
}

export function loadKillGateReport(root: string = process.cwd()): KillGateReport {
  return JSON.parse(readFileSync(join(root, 'evals', 'kill-gate-report.json'), 'utf8')) as KillGateReport;
}
