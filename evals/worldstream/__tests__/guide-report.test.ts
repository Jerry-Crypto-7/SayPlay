/**
 * **Report brány A6 — pin na jmenovatel a na nulu výmyslů.**
 *
 * Artefakt `guide.json` má jednu vlastnost, kvůli které celý průvodce existuje:
 * **žádná odpověď nejmenuje objekt, který ve světě není.** A má jednu vlastnost,
 * kterou se ta první dá zadarmo zfalšovat: **chybějící případ**. Report o osmi
 * otázkách místo deseti vypadá líp než poctivý, protože obě čísla, na která se
 * kdokoli podívá, jdou správným směrem — a nikdo si nevšimne, že se dvě otázky
 * po cestě ztratily.
 *
 * Sada proto soudí artefakt, ne kód, a ptá se ho na tři věci: je jmenovatel
 * úplný, má každý případ všechna pole, a je počet výmyslů nula.
 *
 * Znovu ho naměří:
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/guide.measure.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPORT_FILE = fileURLToPath(new URL('../guide.json', import.meta.url));

interface GuideCase {
  readonly worldId: string;
  readonly prompt: string;
  readonly question: string;
  readonly asked: string;
  readonly present: boolean;
  readonly status: string;
  readonly reason: string | null;
  readonly routeLength: number;
  readonly verify: string | null;
  readonly text: string;
  readonly invented: readonly string[];
  readonly ms: number;
}

interface GuideReport {
  readonly measuredAt: string;
  readonly provenance: string;
  readonly summary: {
    readonly total: number;
    readonly worlds: number;
    readonly routes: number;
    readonly certified: number;
    readonly notInWorld: number;
    readonly invented: number;
    readonly slowestMs: number;
  };
  readonly cases: readonly GuideCase[];
}

const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as GuideReport;

describe('guide.json – deset otázek nad pěti světy', () => {
  it('nechybí ani jedna otázka a jmenovatel v souhrnu sedí s případy', () => {
    expect(report.cases).toHaveLength(10);
    expect(report.summary.total, 'souhrn počítá s jiným jmenovatelem než seznam případů').toBe(report.cases.length);
    expect(new Set(report.cases.map((entry) => entry.worldId)).size).toBe(5);
    expect(report.summary.worlds).toBe(5);
    // Dvakrát táž otázka nad týmž světem by byl jeden případ vydaný za dva.
    expect(new Set(report.cases.map((entry) => `${entry.worldId}${entry.asked}`)).size).toBe(10);
  });

  it('žádný případ není bez verdiktu, bez věty ani bez času', () => {
    for (const entry of report.cases) {
      expect(['ROUTE', 'NO_ROUTE', 'NOT_IN_WORLD'], entry.question).toContain(entry.status);
      expect(entry.text.length, `${entry.worldId}/${entry.asked}: odpověď bez věty`).toBeGreaterThan(0);
      expect(Number.isFinite(entry.ms), `${entry.worldId}/${entry.asked}: případ bez času`).toBe(true);
      expect(Number.isInteger(entry.routeLength)).toBe(true);
      // Cesta bez druhého verdiktu by byla tvrzení o důkazu, ne důkaz.
      if (entry.status === 'ROUTE') {
        expect(entry.verify, `${entry.worldId}/${entry.asked}: cesta bez ověření`).toBe('CERTIFIED');
        expect(entry.routeLength).toBeGreaterThan(0);
      } else {
        expect(entry.routeLength).toBe(0);
      }
    }
  });

  it('počet odpovědí, které jmenují objekt mimo svět, je nula', () => {
    const invented = report.cases.filter((entry) => entry.invented.length > 0);
    expect(invented.map((entry) => `${entry.worldId}/${entry.asked}: ${entry.invented.join(', ')}`)).toEqual([]);
    expect(report.summary.invented).toBe(0);
  });

  it('každý svět dostal jednu otázku na to, co v něm je, a jednu na to, co v něm není', () => {
    for (const worldId of new Set(report.cases.map((entry) => entry.worldId))) {
      const asked = report.cases.filter((entry) => entry.worldId === worldId);
      expect(asked.filter((entry) => entry.present), worldId).toHaveLength(1);
      expect(asked.filter((entry) => !entry.present), worldId).toHaveLength(1);
    }
    // A nepřítomné slovo dostane vždycky pojmenované „to tu není", nikdy cestu.
    for (const entry of report.cases.filter((candidate) => !candidate.present))
      expect(entry.status, entry.question).toBe('NOT_IN_WORLD');
  });
});
