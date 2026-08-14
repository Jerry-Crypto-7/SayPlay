/**
 * Kill gate report (T21) — dokázaný **bez jediného živého volání**.
 *
 * Vstupem jsou hotové `LiveReport` a `SessionReport`, takže se tu dá dokázat
 * všechno kromě samotného volání poskytovatele: co je čitatel každé míry, kdo
 * rozhoduje o razítku brány, kdy report vůbec nesmí vzniknout a která čísla se
 * vydávají za naměřená, přestože jsou vlastností potrubí.
 *
 * ## Proč se odpovědi doopravdy zapisují na disk
 *
 * Protože `storedProfiles` je čte odtamtud, a to je celý smysl té kontroly.
 * Fixture, která by profil dodala jako hodnotu, by testovala tu verzi brány,
 * kterou nález u T18 označil za nedostatečnou — *„brána musí číst razítko zpátky
 * z uložených odpovědí na disku, ne z proměnné, do které se zkopírovalo"*.
 * Rozhodující test níž proto staví hlavičku, která tvrdí `api`, nad souborem,
 * který nese `subscription`.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClusterFloorError, statsProtocol, type StatsProtocol } from '../cluster';
import { aggregateGates, killGateReport, writeKillGateReport, type KillGateInput } from '../kill-gate';
import { KILL_GATE_REPORT, gateStanding, storedProfiles, type LiveCaseResult, type LiveReport } from '../live';
import type { ProviderProfile } from '../preflight';
import type { SessionReport, SessionResult, SessionTurn } from '../session';

const CREATE_IDS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15'] as const;

/** Čtyři relace, které zmrazená sada unese — `editSessions()` vrací právě tyhle. */
const SESSIONS: readonly (readonly [string, readonly string[]])[] = [
  ['C01', ['E07', 'E15', 'E18']],
  ['C02', ['E01', 'E10', 'E19']],
  ['C03', ['E04', 'E13', 'E20']],
  ['C09', ['E08', 'E14', 'E24']],
];

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'killgate-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Zapíše razítka profilu tam, kam je zapisuje `storeResponse` — na disk. */
function stamp(root: string, runId: string, ids: readonly string[], profile: ProviderProfile): string {
  const dir = join(root, runId, 'responses');
  mkdirSync(dir, { recursive: true });
  for (const id of ids)
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ synthetic: false, forPrompt: id, profile }, null, 2), 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// Stavba vstupů
// ---------------------------------------------------------------------------

interface CaseSpec {
  readonly id: string;
  readonly verdict?: 'FULFILLED' | 'ROBUST' | 'NO_FIT' | 'FAULT';
  readonly repaired?: boolean;
  readonly certified?: boolean;
  readonly divergent?: boolean;
}

function liveCase(spec: CaseSpec): LiveCaseResult {
  const certified = spec.certified ?? spec.verdict === 'FULFILLED';
  return {
    id: spec.id,
    profile: 'api',
    verdict: spec.verdict ?? 'ROBUST',
    gates: [],
    unmet: [],
    stoppedAt: certified ? null : 'witness',
    parsedVia: 'direct',
    repairApplied: spec.repaired === true ? ['revision.reset'] : [],
    browserReplayed: certified,
    browserHash: certified ? `browser-${spec.id}` : null,
    offlineHash: certified ? `offline-${spec.id}` : null,
    rawHash: `raw-${spec.id}`,
    bodyHash: `body-${spec.id}`,
    responsePath: `/responses/${spec.id}.json`,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    records: [],
    failures:
      spec.divergent === true
        ? [{ caseId: spec.id, kind: 'browser-divergence', detail: 'prohlížeč vs Node' }]
        : [],
  };
}

function createReport(root: string, specs: readonly CaseSpec[], profile: ProviderProfile = 'api', extra: Partial<LiveReport> = {}): LiveReport {
  const runId = 'create-run';
  const dir = stamp(root, runId, specs.map((spec) => spec.id), profile);
  const cases = specs.map(liveCase);
  return {
    runId,
    model: 'gpt-test',
    profile,
    cases,
    records: [],
    counts: { FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 },
    fulfilled: 0,
    attempted: cases.length,
    total: cases.length,
    complete: true,
    stoppedReason: null,
    spentUsd: 0,
    capUsd: 50,
    calls: cases.length,
    callCap: null,
    browserReplays: 0,
    responsesDir: dir,
    failures: [],
    ok: true,
    ...extra,
  };
}

interface TurnSpec {
  readonly id: string;
  readonly verdict?: 'FULFILLED' | 'ROBUST' | 'NO_FIT' | 'FAULT';
  readonly committed?: boolean;
  readonly divergent?: boolean;
}

function turn(spec: TurnSpec, index: number): SessionTurn {
  const committed = spec.committed ?? spec.verdict === 'FULFILLED';
  return {
    index,
    promptId: spec.id,
    editClass: 'neuveden',
    verdict: spec.verdict ?? 'ROBUST',
    gates: [],
    unmet: [],
    committed,
    stoppedAt: committed ? null : 'witness',
    changedLeaves: [],
    behaviour: { effect: committed ? 'moved' : 'unobservable', detail: '' },
    passed: committed && spec.verdict === 'FULFILLED',
    parsedVia: 'direct',
    rawHash: `raw-${spec.id}`,
    bodyHash: `body-${spec.id}`,
    responsePath: `/responses/${spec.id}.json`,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: null,
    browserReplayed: committed,
    browserHash: null,
    offlineHash: null,
    frozenBodyMatch: null,
    records: [],
    failures:
      spec.divergent === true ? [{ caseId: spec.id, kind: 'browser-divergence', detail: 'prohlížeč vs Node' }] : [],
  };
}

function editReport(
  root: string,
  plans: readonly (readonly [string, readonly TurnSpec[]])[],
  profile: ProviderProfile = 'api',
  extra: Partial<SessionReport> = {},
): SessionReport {
  const runId = 'edit-run';
  const dir = stamp(root, runId, plans.flatMap(([, specs]) => specs.map((spec) => spec.id)), profile);
  const sessions: SessionResult[] = plans.map(([baseWorld, specs]) => ({
    baseWorld,
    turns: specs.map((spec, index) => turn(spec, index + 1)),
    preservation: [],
    passed: specs.every((spec) => spec.verdict === 'FULFILLED'),
    abortedAt: null,
  }));
  const turns = sessions.flatMap((session) => session.turns);
  const passed = sessions.filter((session) => session.passed).length;
  const turnsPassed = turns.filter((entry) => entry.passed).length;
  const turnRate = turns.length === 0 ? null : turnsPassed / turns.length;
  return {
    runId,
    model: 'gpt-test',
    profile,
    sessions,
    records: [],
    sessionsPassed: passed,
    sessionsCompleted: sessions.length,
    sessionsPlanned: sessions.length,
    sessionSuccessRate: sessions.length === 0 ? null : passed / sessions.length,
    turnsPassed,
    turnsRun: turns.length,
    turnSuccessRate: turnRate,
    independenceEstimate: turnRate === null ? null : turnRate ** 3,
    counts: { FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 },
    complete: true,
    stoppedReason: null,
    spentUsd: null,
    capUsd: null,
    calls: turns.length,
    callCap: 40,
    browserReplays: 0,
    responsesDir: dir,
    frozenBodyMatches: [],
    failures: [],
    ok: true,
    ...extra,
  };
}

/** Plná sada: 15 tvorb + 4 relace po třech tazích, všechno `api` a bez vad. */
function fullInput(root: string, overrides: { create?: readonly CaseSpec[]; edit?: readonly (readonly [string, readonly TurnSpec[]])[] } = {}): KillGateInput {
  return {
    create: createReport(root, overrides.create ?? CREATE_IDS.map((id) => ({ id }))),
    edit: editReport(
      root,
      overrides.edit ?? SESSIONS.map(([base, ids]) => [base, ids.map((id) => ({ id }))] as const),
    ),
  };
}

// ---------------------------------------------------------------------------

describe('razítko brány', () => {
  it('GATE dostane jedině běh, jehož všechny odpovědi na disku nesou api', () => {
    expect(gateStanding(['api', 'api']).grade).toBe('GATE');
    expect(gateStanding(['api']).headlineClaimable).toBe(true);
  });

  it('předplatné, smíchaný běh i prázdno jsou DEVELOPMENTAL', () => {
    for (const profiles of [['subscription'], ['api', 'subscription'], []] as ProviderProfile[][]) {
      const standing = gateStanding(profiles);
      expect(standing.grade, profiles.join('+') || 'prázdno').toBe('DEVELOPMENTAL');
      expect(standing.headlineClaimable).toBe(false);
      expect(standing.reason.length).toBeGreaterThan(20);
    }
  });

  it('profil se čte ze souboru na disku, ne z hlavičky reportu', () => {
    const root = tempRoot();
    // Hlavička i případy tvrdí `api`. Na disku leží `subscription`. Kontrola nad
    // hodnotou v paměti by tenhle běh orazítkovala jako výsledek brány.
    const input: KillGateInput = {
      create: createReport(root, CREATE_IDS.map((id) => ({ id })), 'api'),
      edit: editReport(root, SESSIONS.map(([base, ids]) => [base, ids.map((id) => ({ id }))] as const), 'api'),
    };
    stamp(root, 'create-run', [...CREATE_IDS], 'subscription');

    const report = killGateReport(input);
    expect(report.gate.grade).toBe('DEVELOPMENTAL');
    expect(report.gate.profiles).toEqual(['api', 'subscription']);
  });

  it('odpověď bez razítka je chyba, ne neznámý profil', () => {
    const root = tempRoot();
    const dir = join(root, 'r', 'responses');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'C01.json'), JSON.stringify({ forPrompt: 'C01' }), 'utf8');
    // Bez téhle výjimky by prázdná množina tiše spadla na DEVELOPMENTAL a nikdo
    // by se nedozvěděl, že se artefakt rozešel se svým vlastním zápisem.
    expect(() => storedProfiles([dir])).toThrow(/razítko profilu/);
  });

  it('chybějící adresář odpovědí je chyba', () => {
    expect(() => storedProfiles([join(tempRoot(), 'neni')])).toThrow(/neexistuje/);
  });
});

describe('čitatel je FULFILLED, ne validita a ne commitovatelnost', () => {
  it('každá míra to o sobě říká strojově', () => {
    const report = killGateReport(fullInput(tempRoot()));
    for (const rate of [report.fulfilledRate, report.rawPatchPassRate, report.firstRequestCommitRate])
      expect(rate.numerator, rate.id).toBe('FULFILLED');
  });

  it('případ, který se jen commitnul, do žádného čitatele nespadne', () => {
    const root = tempRoot();
    // `C01` je certifikovaný svět s verdiktem ROBUST: potrubím prošel celý,
    // kontrakt nesplnil. Míra vázaná na commitovatelnost by ho započítala.
    const report = killGateReport(
      fullInput(root, {
        create: CREATE_IDS.map((id) => (id === 'C01' ? { id, verdict: 'ROBUST' as const, certified: true } : { id })),
      }),
    );
    expect(report.fulfilledRate.successIds).not.toContain('C01');
    expect(report.rawPatchPassRate.successIds).not.toContain('C01');
    expect(report.firstRequestCommitRate.successIds).not.toContain('C01');
    // A přitom je to přijatý kandidát — invariant potrubí ho vidí.
    expect(report.structuralContract.accepted).toBeGreaterThan(0);
  });

  it('FULFILLED po opravě sráží syrovou míru, ne míru po jedné opravě', () => {
    const root = tempRoot();
    const report = killGateReport(
      fullInput(root, {
        create: CREATE_IDS.map((id) =>
          id === 'C04' ? { id, verdict: 'FULFILLED' as const, repaired: true } : { id },
        ),
      }),
    );
    expect(report.rawPatchPassRate.successIds).not.toContain('C04');
    expect(report.firstRequestCommitRate.successIds).toContain('C04');
    expect(report.firstRequestCommitRate.successes).toBe(report.rawPatchPassRate.successes + 1);
  });

  it('prahy jdou ze zmrazeného protokolu, neopisují se sem', () => {
    const gates = aggregateGates();
    const report = killGateReport(fullInput(tempRoot()));
    expect(report.rawPatchPassRate.floor).toBe(gates.rawPatchPassRate.floor);
    expect(report.firstRequestCommitRate.floor).toBe(gates.firstRequestCommitRate.floor);
    expect(report.structuralContract.floor).toBe(gates.structuralContract.floor);
    expect(report.wilsonCaveat).toBe(gates.wilsonCaveat);
  });

  it('podlaha se soudí proti naměřené míře', () => {
    const root = tempRoot();
    const good = killGateReport(
      fullInput(root, {
        create: CREATE_IDS.map((id) => ({ id, verdict: 'FULFILLED' as const })),
        edit: SESSIONS.map(([base, ids]) => [base, ids.map((id) => ({ id, verdict: 'FULFILLED' as const }))] as const),
      }),
    );
    expect(good.rawPatchPassRate.rate).toBe(1);
    expect(good.rawPatchPassRate.meetsFloor).toBe(true);

    const bad = killGateReport(fullInput(tempRoot()));
    expect(bad.rawPatchPassRate.rate).toBe(0);
    expect(bad.rawPatchPassRate.meetsFloor).toBe(false);
  });
});

describe('claimable — profil jde do každého tvrzení, ne jen do hlavičky', () => {
  it('vývojový běh nemá jedinou citovatelnou míru', () => {
    const root = tempRoot();
    const report = killGateReport({
      create: createReport(root, CREATE_IDS.map((id) => ({ id })), 'subscription'),
      edit: editReport(root, SESSIONS.map(([base, ids]) => [base, ids.map((id) => ({ id }))] as const), 'subscription'),
    });
    expect(report.gate.grade).toBe('DEVELOPMENTAL');
    for (const rate of [report.fulfilledRate, report.rawPatchPassRate, report.firstRequestCommitRate])
      expect(rate.claimable, `${rate.id} se tváří jako výsledek brány`).toBe(false);
  });

  it('api běh je citovatelný', () => {
    const report = killGateReport(fullInput(tempRoot()));
    expect(report.gate.grade).toBe('GATE');
    for (const rate of [report.fulfilledRate, report.rawPatchPassRate, report.firstRequestCommitRate])
      expect(rate.claimable, rate.id).toBe(true);
  });
});

describe('odmítnutí reportu pod minimem clusterů', () => {
  it('spadne dřív, než vznikne soubor', () => {
    const root = tempRoot();
    const protocol: StatsProtocol = statsProtocol();
    // Pět tvorb = pět světů. Protokol žádá aspoň dvanáct.
    const thin: KillGateInput = {
      create: createReport(root, CREATE_IDS.slice(0, 5).map((id) => ({ id }))),
      edit: editReport(root, [SESSIONS[0]].map(([base, ids]) => [base, ids.map((id) => ({ id }))] as const)),
    };
    expect(() => killGateReport(thin)).toThrow(ClusterFloorError);
    expect(() => killGateReport(thin)).toThrow(new RegExp(String(protocol.minWorldClusters)));
  });

  it('plná sada dá patnáct nezávislých světů', () => {
    const report = killGateReport(fullInput(tempRoot()));
    expect(report.corpus.clusters).toBe(15);
    expect(report.corpus.clusters).toBeGreaterThanOrEqual(report.corpus.minWorldClusters);
    // Úpravy patří pod svůj základní svět, ne pod sebe — jinak by clusterů bylo 19.
    expect(report.clustered.clusters.find((cluster) => cluster.world === 'C01')!.trials).toBe(4);
  });

  it('prázdný vstup se odmítne vlastní větou, ne hláškou o statistice', () => {
    const root = tempRoot();
    expect(() => killGateReport({ create: createReport(root, []), edit: editReport(root, []) })).toThrow(
      /neodbavily jediný případ/,
    );
  });
});

describe('bloky, které čitatele FULFILLED nemají a říkají to', () => {
  it('strukturální kontrakt je invariant, ne míra kvality modelu', () => {
    const root = tempRoot();
    const report = killGateReport(
      fullInput(root, {
        create: CREATE_IDS.map((id) =>
          id === 'C02' ? { id, verdict: 'FULFILLED' as const, divergent: true } : { id },
        ),
      }),
    );
    expect(report.structuralContract.violations.map((violation) => violation.id)).toEqual(['C02']);
    expect(report.structuralContract.meetsFloor).toBe(false);
    expect(report.structuralContract.notARate).toMatch(/ne FULFILLED/);
  });

  it('nepřijatý kandidát se strukturální vadou kontrakt neshodí', () => {
    const root = tempRoot();
    // Vada u případu, který systém nepřijal, není porušení kontraktu — kontrakt
    // mluví o **přijatých** kandidátech. Bez `accepted` by to bylo jedno a totéž.
    const report = killGateReport(
      fullInput(root, {
        create: CREATE_IDS.map((id) =>
          id === 'C02' ? { id, verdict: 'ROBUST' as const, certified: false, divergent: true } : { id },
        ),
      }),
    );
    expect(report.structuralContract.violations).toEqual([]);
  });

  it('podíl commitů bez druhého volání je přiznaně strukturální', () => {
    const report = killGateReport(fullInput(tempRoot()));
    expect(report.commitsWithoutSecondCall.structural).toBe(true);
    expect(report.commitsWithoutSecondCall.honestNote).toMatch(/vlastnost potrubí/);
  });

  it('čas do commitu se měří ve voláních, ne ve vteřinách', () => {
    const root = tempRoot();
    const report = killGateReport(
      fullInput(root, {
        create: CREATE_IDS.map((id) =>
          id === 'C04' ? { id, verdict: 'FULFILLED' as const, repaired: true } : { id },
        ),
      }),
    );
    expect(report.timeToCommit.unit).toBe('providerRequests');
    expect(report.timeToCommit.committedAfterOneRepair).toBe(1);
    expect(
      report.timeToCommit.committedOnRawEmission + report.timeToCommit.committedAfterOneRepair + report.timeToCommit.neverCommitted,
    ).toBe(report.cases.length);
    expect(report.timeToCommit.byCase.find((entry) => entry.id === 'C04')!.requests).toBe(1);

    // Strop je jedno volání na případ, ne počet případů. Kdyby se `maxRequestsUsed`
    // dopočítával z délky sady, report by nad 27 případy tvrdil ocas až do 27
    // požadavků — tedy distribuci, kterou potrubí P1 nemá jak vyrobit.
    expect(report.cases.length).toBeGreaterThan(1);
    expect(report.timeToCommit.maxRequestsUsed).toBe(1);
    // Případ, který se necommitnul, žádný čas do commitu nemá. `1` by tu byla
    // vymyšlená hodnota u něčeho, co nikdy nedoběhlo.
    expect(report.timeToCommit.byCase.find((entry) => entry.id === 'C01')!.requests).toBeNull();
    expect(report.timeToCommit.byCase.filter((entry) => entry.requests === null)).toHaveLength(
      report.timeToCommit.neverCommitted,
    );
  });
});

describe('tříúpravová relace', () => {
  it('míra je passed/completed, nikdy dopočet z nezávislosti tahů', () => {
    const root = tempRoot();
    const report = killGateReport(
      fullInput(root, {
        edit: SESSIONS.map(
          ([base, ids], index) =>
            [base, ids.map((id) => ({ id, verdict: index === 0 ? ('FULFILLED' as const) : ('ROBUST' as const) }))] as const,
        ),
      }),
    );
    expect(report.threeEditSession.rate).toBe(1 / 4);
    expect(report.threeEditSession.turnRate).toBe(3 / 12);
    // Kdyby se míra relací dopočítávala, vyšla by 0,25³ = 0,015625.
    expect(report.threeEditSession.rate).not.toBe(report.threeEditSession.independenceEstimate);
    expect(report.threeEditSession.independenceEstimate).toBeCloseTo((3 / 12) ** 3, 12);
  });
});

describe('neúplný běh', () => {
  it('se přizná a řekne proč', () => {
    const root = tempRoot();
    const report = killGateReport({
      create: createReport(root, CREATE_IDS.slice(0, 13).map((id) => ({ id })), 'api', {
        complete: false,
        stoppedReason: 'CALL_CAP_EXHAUSTED: strop 13 volání je vyčerpaný',
        total: 15,
      }),
      edit: editReport(root, SESSIONS.map(([base, ids]) => [base, ids.map((id) => ({ id }))] as const)),
    });
    expect(report.complete).toBe(false);
    expect(report.incompleteReason).toMatch(/CALL_CAP_EXHAUSTED/);
    expect(report.completedCases).toBeLessThan(report.plannedCases);
  });

  it('úplný běh nemá důvod zastavení', () => {
    const report = killGateReport(fullInput(tempRoot()));
    expect(report.complete).toBe(true);
    expect(report.incompleteReason).toBeNull();
    expect(report.completedCases).toBe(report.plannedCases);
  });
});

describe('zápis', () => {
  it('jediný zapisovatel trefí vyhrazené jméno a gate je nad čísly', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'evals'), { recursive: true });
    const report = killGateReport(fullInput(root));
    const path = writeKillGateReport(report, root);

    expect(path).toBe(join(root, 'evals', KILL_GATE_REPORT));
    const raw = readFileSync(path, 'utf8');
    // Pořadí klíčů je součást tvrzení: kdo soubor otevře, přečte razítko dřív
    // než jakékoli číslo. „Někde nad `fulfilledRate`" na to nestačí — razítko
    // schované mezi patnácti klíči je pořád formálně první a nikdo ho nepřečte.
    const keys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
    expect(keys.slice(0, 2)).toEqual(['schema', 'gate']);
    expect((JSON.parse(raw) as { schema: string }).schema).toBe('kill-gate-report.v1');
  });

  it('vyhrazené jméno má v celém harnessu jedinou definici', () => {
    // Nález u T18: dokud vyhrazené jméno nemá jediného zapisovatele, obejde
    // bránu kdokoli obyčejným `writeFileSync` a nic nezčervená. Druhý literál je
    // první krok k druhému zapisovateli — a jediný, který jde chytit strojově.
    const sources = readdirSync(join('evals', 'harness'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(join('evals', 'harness', name), 'utf8')] as const);
    const owners = sources.filter(([, text]) => text.includes(`'${KILL_GATE_REPORT}'`)).map(([name]) => name);
    expect(owners).toEqual(['live.ts']);
  });

  it('report drží odkaz na surové záznamy', () => {
    const report = killGateReport(fullInput(tempRoot()));
    for (const entry of report.cases) {
      expect(entry.responsePath.length).toBeGreaterThan(0);
      expect(entry.rawHash.length).toBeGreaterThan(0);
    }
    expect(report.run.responseDirs).toHaveLength(2);
  });
});
