import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import { commitRoutedParts } from '../../src/app/api/edit/commit';
import { certifySteps } from '../../src/model/certify';
import { EMISSION_MODEL } from '../../src/model/prompt';
import { routePatch } from '../../src/patch/router';
import { validateEmission } from '../harness/chain';
import { causeOf, measureRejects, REPORT_PATH, type RejectStage } from '../measure-rejects';

/**
 * Běžec měření z T12 — `npm run measure:rejects`.
 *
 * **Co tenhle soubor tvrdí a co netvrdí.** Netvrdí, kolik odmítnutí má vyjít.
 * Číslo je naměřený stav systému a jde do `evals/reject-causes.json`; kdyby se
 * sem zapsalo jako očekávání, zamklo by se tím dnešní chování jako požadované
 * a T13 by muselo přepsat test, aby směl něco zlepšit.
 *
 * Tvrdí, že **měření je poctivé**: histogram se doopravdy sečte na počet
 * odmítnutých, obě třídy příčin ho vyčerpají beze zbytku, každý odmítnutý
 * případ nese fázi i důvod, a nic z toho nejde odvodit z konstanty vedle testu.
 *
 * Měření je zároveň brána proti vakuóznímu běhu: sada, ve které by se korpus
 * nenačetl a nezměřilo se nic, by se jinak tvářila zeleně.
 */

const ARTIFACT = join(process.cwd(), REPORT_PATH);

describe('evals/measure-rejects — histogram sedí na to, co se naměřilo', () => {
  const report = measureRejects();

  it('proteče celý zmrazený korpus, ne jeho část', () => {
    const frozen = readFileSync(join(process.cwd(), report.source), 'utf8').trim().split('\n');
    expect(report.total).toBe(frozen.length);
    expect(report.cases.length).toBe(report.total);
    // Bez tohohle by prázdný korpus prošel všemi ostatními aserceni naprázdno.
    expect(report.total).toBeGreaterThan(0);
    expect(report.rejected).toBeGreaterThan(0);
  });

  it('každý záznam skončí právě jedním výsledkem a nic nechybí', () => {
    expect(report.applied + report.declined + report.rejected).toBe(report.total);
    expect(new Set(report.cases.map((entry) => entry.id)).size).toBe(report.total);
  });

  it('declined je deklarované NO_FIT z emise, ne přejmenované přijetí', () => {
    // Druhý zdroj, ne tentýž výpočet: anotace se čte přímo ze zmrazeného těla.
    // Bez toho by se `declined` dalo počítat mezi přijaté a všechny součty by
    // pořád seděly — poctivé odmítnutí sebe sama by se tím vydávalo za úspěch.
    const declaredNoFit = new Map(
      readFileSync(join(process.cwd(), report.source), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { forPrompt: string; body: { simOutcome?: unknown } })
        .map((row) => [row.forPrompt, row.body.simOutcome === 'NO_FIT'] as const),
    );

    for (const entry of report.cases) {
      expect(declaredNoFit.get(entry.id), `${entry.id}`).toBe(entry.outcome === 'declined');
    }
    expect(report.declined).toBeGreaterThan(0);
  });

  it('součet položek histogramu se rovná počtu odmítnutých', () => {
    const sum = (tally: Readonly<Record<string, number>>): number =>
      Object.values(tally).reduce((total, count) => total + count, 0);

    expect(sum(report.byReason)).toBe(report.rejected);
    expect(sum(report.byStage)).toBe(report.rejected);
  });

  it('nedohratelnost a nepřesná interpretace vyčerpají odmítnutí beze zbytku', () => {
    expect(report.byCause.unwinnable + report.byCause.imprecise).toBe(report.rejected);
    // Obě třídy musí být obsazené, jinak by oddělení nic neoddělovalo.
    expect(report.byCause.unwinnable).toBeGreaterThan(0);
    expect(report.byCause.imprecise).toBeGreaterThan(0);
  });

  it('zařazení případu souhlasí s tabulkou fází, kterou report vypisuje', () => {
    for (const entry of report.cases) {
      if (entry.outcome !== 'rejected') {
        expect(entry.stage, `${entry.id} není odmítnutý, ale nese fázi`).toBeNull();
        expect(entry.cause, `${entry.id} není odmítnutý, ale nese třídu`).toBeNull();
        continue;
      }
      const stage = entry.stage as RejectStage;
      expect(entry.cause, `${entry.id}`).toBe(causeOf(stage));
      expect(report.causeStages[causeOf(stage)], `${entry.id}: ${stage} chybí v tabulce tříd`).toContain(stage);
    }
  });

  it('každé odmítnutí nese důvod i místo, nikdy prázdný řetězec', () => {
    for (const entry of report.cases.filter((row) => row.outcome === 'rejected')) {
      expect(entry.reason, `${entry.id} nemá důvod`).not.toBe('');
      expect(entry.detail, `${entry.id} nemá detail`).not.toBe('');
    }
  });

  it('podíl aplikovaných je spočítaný z případů, ne zapsaný', () => {
    for (const [branch, summary] of Object.entries(report.branches)) {
      const cases = report.cases.filter((entry) => entry.branch === branch);
      expect(summary.total, branch).toBe(cases.length);
      expect(summary.applied, branch).toBe(cases.filter((entry) => entry.outcome === 'applied').length);
      expect(summary.appliedShare, branch).toBeCloseTo(summary.applied / summary.total, 10);
    }
    expect(report.branches.create.total + report.branches.edit.total).toBe(report.total);
    expect(report.appliedShare).toBeCloseTo(report.applied / report.total, 10);
  });

  it('tvorba se soudí produkční cestou — stejná fáze i důvod jako certifySteps', () => {
    // Druhý oracle na to, co modul tvrdí v docblocku: že měří rozhodnutí, které
    // vydá `POST /api/emit`, a ne vlastní představu o něm. `certifySteps` je
    // produkční funkce toho endpointu; kdyby si měření fázi nebo důvod vymyslelo,
    // rozejdou se tady. Bez tohohle by jakákoli podvržená fáze prošla.
    const frozen = readFileSync(join(process.cwd(), report.source), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { forPrompt: string; branch: string; body: unknown })
      .filter((row) => row.branch === 'create');

    for (const row of frozen) {
      const steps = certifySteps({
        promptId: row.forPrompt,
        upstream: { model: EMISSION_MODEL, system: '', user: '' },
        provenance: null,
        body: row.body,
      });
      let next = steps.next();
      while (!next.done) next = steps.next();

      const rejection = next.value.body.rejection as { stage: string; reason: string } | null;
      const measured = report.cases.find((entry) => entry.id === row.forPrompt);
      const expectedStage = next.value.body.outcome === 'CERTIFIED' ? null : (rejection as { stage: string }).stage;

      expect(measured?.reason, row.forPrompt).toBe(rejection === null ? 'CERTIFIED' : rejection.reason);
      // `declined` je ve slovníku měření výsledek, ne fáze — endpoint ho hlásí
      // jako `rejection.stage: 'declined'` s výsledkem `NO_FIT`.
      expect(measured?.stage ?? (measured?.outcome === 'declined' ? 'declined' : null), row.forPrompt).toBe(
        expectedStage,
      );
    }
    expect(frozen.length).toBe(report.branches.create.total);
  });

  it('editace se soudí produkční cestou — stejná fáze i důvod jako commitRoutedParts', () => {
    // Protějšek kontroly nad tvorbou, a vznikl z přeživší mutace: podvržení
    // `stage` na `witness` v editační větvi prošlo celou sadou, protože jediné
    // tvrzení o fázi bylo, že souhlasí sama se sebou. Druhá implementace
    // commitu neexistuje, takže oracle je **znovuspuštění produkční** —
    // vymyšlená fáze se od ní rozejde, protože se v ní nemá kde vzít.
    const rows = readFileSync(join(process.cwd(), report.source), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { forPrompt: string; branch: string; baseWorld?: string; body: unknown });

    const edits = rows.filter((row) => row.branch === 'edit');
    for (const row of edits) {
      const base = rows.find((entry) => entry.forPrompt === row.baseWorld);
      const baseDoc = validateEmission(base?.body).doc;
      const measured = report.cases.find((entry) => entry.id === row.forPrompt);
      if (baseDoc === null) continue;

      const routed = routePatch({ operations: row.body as readonly Operation[] }, baseDoc);
      if (routed.verdict === 'REJECTED') {
        expect(measured?.stage, row.forPrompt).toBe('routing');
        expect(measured?.reason, row.forPrompt).toBe(routed.reason);
        continue;
      }

      const committed = commitRoutedParts(
        baseDoc,
        routed.patches.map((part) => ({
          part: part.part,
          baseRevision: part.part === 'sim' ? baseDoc.simRevision : baseDoc.lookRevision,
          operations: part.operations,
        })),
      );

      if (committed.outcome === 'CERTIFIED') {
        expect(measured?.outcome, row.forPrompt).toBe('applied');
        expect(measured?.stage, row.forPrompt).toBeNull();
        continue;
      }
      expect(measured?.stage, row.forPrompt).toBe(committed.rejections[0].stage);
      expect(measured?.reason, row.forPrompt).toBe(committed.rejections[0].reason);
    }
    expect(edits.length).toBe(report.branches.edit.total);
  });

  it('měření je deterministické — dva běhy dají tentýž výsledek', () => {
    expect(measureRejects().cases).toEqual(report.cases);
  });

  it('zapíše report', () => {
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const written = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as typeof report;
    expect(written.rejected).toBe(report.rejected);
    expect(written.byCause).toEqual(report.byCause);
  });
});
