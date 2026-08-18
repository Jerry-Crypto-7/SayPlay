/**
 * Zpráva brány §15 — testy.
 *
 * Nosná vlastnost: **zpráva nesmí jít změkčit.** Každá aserce tady chrání jednu
 * cestu, kterou by naměřený pád šel převyprávět na úspěch — chybějící podmínka,
 * podmínka započítaná nad cizí populací, míra bez intervalu, nebo razítko
 * „vývojový běh" schované až za čísly.
 *
 * Syntetické sondy vznikají klonem naměřeného reportu a jeho mutací. Ručně
 * psaná fixtura by byla druhý zdroj pravdy o tvaru `KillGateReport` a rozešla
 * by se s tím prvním; klon se rozejít nemůže.
 */
import { describe, expect, it } from 'vitest';

import type { KillGateReport } from '../../harness/kill-gate';
import {
  GATE_DATE,
  evaluateConditions,
  killGateReportFile,
  loadKillGateReport,
  passesGate,
  renderGateReport,
  type ConditionStatus,
  type ConditionVerdict,
} from '../run/kill-gate';

const report = loadKillGateReport();
const rendered = renderGateReport(report);

/** Klon, na kterém se smí mutovat — `report` je readonly a sdílený. */
function clone(): KillGateReport {
  return JSON.parse(JSON.stringify(report)) as KillGateReport;
}

function verdict(id: string, source: KillGateReport = report): ConditionVerdict {
  const found = evaluateConditions(source).conditions.find((c) => c.id === id);
  expect(found, `podmínka ${id} ve zprávě chybí`).toBeDefined();
  return found as ConditionVerdict;
}

/**
 * Pořadí i jména jsou ze specifikace, ne z implementace. Kdyby se podmínka
 * ztratila nebo přeskládala, dvě čtení zprávy by se nedala porovnat — a ztráta
 * podmínky je navíc tichý způsob, jak bránu „splnit".
 */
const SPEC_ORDER = [
  'createCertified',
  'editAppliedWithoutReset',
  'witnessWinsInBrowser',
  'seedHashIdentity',
  'noUncertifiedCommitted',
  'threeDistinctTopologies',
  'twoStructuralEdits',
  'flagshipHookFiveTimes',
];

describe('osm podmínek §15', () => {
  it('je jich osm, v pořadí ze specifikace', () => {
    const eight = evaluateConditions(report);
    expect(eight.conditions.map((c) => c.id)).toEqual(SPEC_ORDER);
    expect(eight.required).toBe(8);
  });

  it('každá podmínka nese číslo, ne jen stav', () => {
    for (const c of evaluateConditions(report).conditions) {
      expect(c.measured.length, `${c.id} nemá co vykázat`).toBeGreaterThan(20);
      expect(c.evidence.length, `${c.id} nemá zdroj`).toBeGreaterThan(10);
      expect(c.statement.length).toBeGreaterThan(20);
    }
  });

  it('bráně se započítá jedině splněná podmínka naměřená nad populací běhu', () => {
    const statuses: ConditionStatus[] = ['MET', 'MET_BELOW_DENOMINATOR', 'NOT_MET', 'NOT_MEASURED'];
    const probes = statuses.flatMap((status) =>
      [true, false].map((overRunPopulation) => ({
        id: `${status}-${overRunPopulation}`,
        statement: 's',
        status,
        overRunPopulation,
        measured: 'm',
        evidence: 'e',
        note: null,
      })),
    );
    const passing = probes.filter(passesGate).map((p) => p.id);
    expect(passing).toEqual(['MET-true']);
  });

  it('nad naměřeným během projde bránou právě jedna podmínka', () => {
    const eight = evaluateConditions(report);
    expect(eight.conditions.filter(passesGate).map((c) => c.id)).toEqual(['twoStructuralEdits']);
    expect(eight.passed).toBe(1);
    expect(eight.allMet).toBe(false);
  });
});

describe('podmínky měřené nad tímhle během', () => {
  it('tvorba: 10/15 přijatých proti prahu 8/10', () => {
    const c = verdict('createCertified');
    expect(c.status).toBe('NOT_MET');
    expect(c.overRunPopulation).toBe(true);
    expect(c.measured).toContain('10/15');
  });

  it('tvorba jde na SPLNĚNO, až když přijetí skutečně stoupne', () => {
    const mutant = clone();
    for (const c of mutant.cases as unknown as { accepted: boolean }[]) {
      c.accepted = true;
    }
    expect(verdict('createCertified', mutant).status).toBe('MET');
    expect(verdict('editAppliedWithoutReset', mutant).status).toBe('MET');
  });

  it('editace: 7/12 přijatých proti prahu 8/10', () => {
    const c = verdict('editAppliedWithoutReset');
    expect(c.status).toBe('NOT_MET');
    expect(c.overRunPopulation).toBe(true);
    expect(c.measured).toContain('7/12');
  });

  it('necertifikovaný kandidát: vlastnost drží, jmenovatel ne', () => {
    const c = verdict('noUncertifiedCommitted');
    expect(c.status).toBe('MET_BELOW_DENOMINATOR');
    expect(c.measured).toContain('27');
    expect(c.measured).toContain('100');
  });

  it('sto pokusů z podmínky nezmizí, když jich doběhne 27', () => {
    const full = clone();
    (full as { completedCases: number }).completedCases = 100;
    expect(verdict('noUncertifiedCommitted', full).status).toBe('MET');

    const violated = clone();
    (violated.structuralContract as { meetsFloor: boolean }).meetsFloor = false;
    expect(verdict('noUncertifiedCommitted', violated).status).toBe('NOT_MET');
  });

  it('strukturální úpravy: dvě přijaté ve třídách vložení a smazání pravidla', () => {
    const c = verdict('twoStructuralEdits');
    expect(c.status).toBe('MET');
    expect(c.overRunPopulation).toBe(true);
    expect(c.measured).toContain('E10');
    expect(c.measured).toContain('E15');
  });

  it('jediná procházející podmínka spadne, když přijaté strukturální úpravy zmizí', () => {
    const mutant = clone();
    for (const cls of mutant.perClassFloors) {
      for (const m of cls.members as unknown as { record: { accepted: boolean } }[]) {
        m.record.accepted = false;
      }
    }
    expect(verdict('twoStructuralEdits', mutant).status).toBe('NOT_MET');
    expect(evaluateConditions(mutant).passed).toBe(0);
  });
});

describe('podmínky, které tenhle běh nezměřil', () => {
  it('nejsou započítané, i když je vlastnost dokázaná jinde', () => {
    for (const id of ['witnessWinsInBrowser', 'seedHashIdentity', 'threeDistinctTopologies', 'flagshipHookFiveTimes']) {
      const c = verdict(id);
      expect(c.overRunPopulation, `${id} se tváří jako měřený nad během`).toBe(false);
      expect(passesGate(c), `${id} se započítal bráně`).toBe(false);
    }
  });

  it('determinismus hashe se vykazuje jako dokázaný, ale mimo tenhle běh', () => {
    const c = verdict('seedHashIdentity');
    expect(c.status).toBe('MET');
    expect(passesGate(c)).toBe(false);
  });
});

describe('vykreslená zpráva', () => {
  it('razítko běhu stojí dřív než kterékoli číslo', () => {
    const stamp = rendered.indexOf('DEVELOPMENTAL');
    const firstRate = rendered.indexOf('rawPatchPassRate');
    expect(stamp).toBeGreaterThan(-1);
    expect(firstRate).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(firstRate);
  });

  it('řekne nahlas, že se z běhu nesmí citovat', () => {
    expect(report.gate.headlineClaimable).toBe(false);
    expect(rendered).toContain('**Citovatelné: NE**');
    expect(rendered).toContain(report.gate.reason);
  });

  it('u obou sazeb uvádí bod, mez i práh', () => {
    for (const block of [report.rawPatchPassRate, report.firstRequestCommitRate]) {
      expect(rendered).toContain(`${block.successes}/${block.trials}`);
      expect(block.wilson).not.toBeNull();
    }
    expect(rendered).toContain('7,4 %');
    expect(rendered).toContain('85,0 %');
    expect(rendered).toContain('93,0 %');
  });

  it('nese poznámku o shlukování a clusterovaný interval', () => {
    expect(rendered).toContain(report.wilsonCaveat);
    expect(rendered).toContain('19,0 %');
    expect(rendered).toContain(String(report.clustered.interval.seed));
  });

  it('uvádí plánovaný i skutečný jmenovatel', () => {
    expect(rendered).toContain('100 editačních tahů');
    expect(rendered).toContain(`${report.completedCases} případů`);
  });

  it('tříúpravovou relaci vykazuje přímo a dopočet jen vedle ní', () => {
    expect(rendered).toContain(
      `**${report.threeEditSession.sessionsPassed}/${report.threeEditSession.sessionsCompleted}**`,
    );
    expect(rendered).toContain(report.threeEditSession.contrastNote);
  });

  it('u žádné třídy netvrdí, že podlaha hradí', () => {
    expect(rendered).toContain('Žádná třída nehradí');
    for (const cls of report.perClassFloors) {
      expect(cls.trials).toBeLessThan(12);
      expect(cls.gated).toBe(false);
    }
  });

  it('vypíše všech osm podmínek zvlášť', () => {
    for (const id of SPEC_ORDER) {
      expect(rendered, `podmínka ${id} ve vykreslení chybí`).toContain(`\`${id}\``);
    }
  });

  /**
   * Zámek metriky divergence si sám předepisuje, že to má zpráva brány napsat
   * nahlas (`statusReason`). Kdyby zámek dostal odběratele a zpráva o tom
   * mlčela, tvrdila by o projektu něco, co přestalo platit.
   */
  it('říká, že zamčená metrika divergence nemá odběratele', () => {
    expect(rendered).toContain('`unused`');
    expect(rendered).toContain('P5 T504');
  });

  it('končí verdiktem, že brána padá', () => {
    expect(rendered).toContain('**Brána padá.**');
    expect(rendered).toContain('1 z 8 podmínek');
  });

  /**
   * Zpráva na disku JE tenhle snapshot. Regeneruje se `npx vitest run -u
   * evals/gates/__tests__/kill-gate-report.test.ts`; jinak jde každá odchylka
   * mezi `evals/kill-gate-report.json` a vykreslením červeně. Je to jediná
   * pojistka proti tomu, aby se zpráva a měření tiše rozešly — ručně psaná
   * zpráva by se rozešla první den, kdy se čísla dotkne kdokoli jiný.
   */
  it('soubor na disku se rovná vykreslení', async () => {
    expect(killGateReportFile()).toContain(GATE_DATE);
    await expect(rendered).toMatchFileSnapshot(killGateReportFile());
  });
});
