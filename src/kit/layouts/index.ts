import type { PaletteName } from '../palettes';
import dunesTerrace from './dunes-terrace.json';
import foundryHall from './foundry-hall.json';
import frostPlateau from './frost-plateau.json';
import harborPier from './harbor-pier.json';
import kilnCourt from './kiln-court.json';
import thicketClearing from './thicket-clearing.json';

export type Placement = {
  readonly piece: string;
  /** Pole mřížky `[x, z]`, celá čísla. Jednotka je 1. */
  readonly cell: readonly [number, number];
  /** Výška, ve které **spočine spodek** kusu. Default 0 = stojí na zemi. */
  readonly level?: number;
  /** Otočení kolem osy Y ve čtvrtinách otáčky. */
  readonly yaw?: number;
  /** Posun uvnitř pole, aby kusy nestály jen ve středech. */
  readonly offset?: readonly [number, number];
};

export type Layout = {
  readonly id: string;
  readonly title: string;
  readonly palette: PaletteName;
  readonly placements: readonly Placement[];
};

/**
 * Ručně skládané layouty. **Tenhle soubor nesmí importovat nic z `three`** —
 * `e2e/kit-layouts.spec.ts` z něj čte seznam v Node procesu Playwrightu a
 * runtime závislost na rendereru by ho zbytečně zatížila. Typ palety se proto
 * bere přes `import type`, který se při překladu zahodí.
 */
export const LAYOUTS = [
  harborPier,
  kilnCourt,
  thicketClearing,
  foundryHall,
  dunesTerrace,
  frostPlateau,
] as unknown as readonly Layout[];

export function layoutById(id: string): Layout | undefined {
  return LAYOUTS.find((layout) => layout.id === id);
}

/**
 * Kanonický podpis půdorysu — invariantní vůči posunu **i otočení**.
 *
 * Dvě rozvržení se shodným podpisem mají tentýž tvar, jen jinak položený.
 * Bez otočení by test „žádné dva layouty nesdílí topologii" propustil tentýž
 * půdorys otočený o 90°, což je přesně ten případ, který si člověk nevšimne.
 */
export function footprintSignature(layout: Layout): string {
  const cells = [...new Set(layout.placements.map(({ cell }) => `${cell[0]},${cell[1]}`))].map(
    (key) => key.split(',').map(Number) as [number, number],
  );

  const candidates: string[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const turned = cells.map(([x, z]): [number, number] => {
      if (turn === 0) return [x, z];
      if (turn === 1) return [-z, x];
      if (turn === 2) return [-x, -z];
      return [z, -x];
    });
    const minX = Math.min(...turned.map(([x]) => x));
    const minZ = Math.min(...turned.map(([, z]) => z));
    candidates.push(
      turned
        .map(([x, z]) => `${x - minX},${z - minZ}`)
        .sort()
        .join(' '),
    );
  }

  return candidates.sort()[0];
}
