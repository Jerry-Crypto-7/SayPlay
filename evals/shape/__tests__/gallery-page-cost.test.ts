/**
 * Pokrývá strop `MESH_DETAIL.high` cenu, kterou tvary doopravdy mají? (P13 `T7-meshbudget`)
 *
 * ## Proč to čte report a neměří samo
 *
 * Wall-clock aserce v jednotkovém testu je vrtkavá — naměřeno 31. 8. 2026, týž
 * tvar `root` dal mezi běhy **1 267 až 2 285 ms** podle toho, co zrovna běželo
 * vedle. Tenhle test proto nic nestopuje: čte **commitnutý** report z běhu
 * `e2e/gallery.spec.ts` a ptá se jedinou otázkou, jestli strop pokrývá to, co
 * se v něm naměřilo. Číslo se tak hýbe jen tehdy, když někdo vědomě přeměří.
 *
 * ## Proč zrovna tenhle report
 *
 * `mesh-budget.json` měří na `/dev/mesh-budget`, což je stránka, která
 * **schválně nic nevykresluje**. V produktu meshing běží vedle živé renderovací
 * smyčky a stojí dvakrát až třikrát tolik; přesně na tom rozdílu byl strop 900
 * ms šest dní špatně a odmítal tři až šest z dvanácti ručních tvarů. Report
 * `gallery-page-cost.json` je z té druhé podmínky.
 *
 * ## Co to netvrdí
 *
 * Že je 2 600 ms správné číslo pro každý budoucí stroj. Tvrdí jen, že pokrývá
 * poslední měření — a když ho příští měření přeroste, ozve se to tady, ne až na
 * prázdné buňce v galerii.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MESH_DETAIL } from '../../../src/shape/types';
import { GALLERY_IDS } from '../gallery';

interface PageCostRow {
  readonly id: string;
  readonly ms: number;
  readonly ok: boolean;
}

interface PageCostReport {
  readonly measuredAt: string;
  readonly resolution: number;
  readonly rows: readonly PageCostRow[];
}

const report = JSON.parse(
  readFileSync(join('evals', 'shape', 'gallery-page-cost.json'), 'utf8'),
) as PageCostReport;

describe('gallery page cost', () => {
  it('measures the rung the budget actually guards', () => {
    expect(report.resolution).toBe(MESH_DETAIL.high.resolution);
  });

  it('covers every hand-written shape with the high rung budget', () => {
    const over = report.rows.filter((row) => row.ms > MESH_DETAIL.high.maxMs);
    expect(
      over.map((row) => `${row.id} ${row.ms} ms`),
      `strop ${MESH_DETAIL.high.maxMs} ms nepokrývá naměřené tvary`,
    ).toEqual([]);
  });

  it('reports every shape, rejected ones included', () => {
    // Kdyby report nesl jen ty, které prošly, příliš nízký strop by se schoval:
    // odmítnuté tvary by mlčely a aserce výš by byla trvale zelená.
    expect([...report.rows].map((row) => row.id).sort()).toEqual([...GALLERY_IDS].sort());
  });
});
