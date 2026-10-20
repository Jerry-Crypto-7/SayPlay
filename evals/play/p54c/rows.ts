/**
 * Věta → kam padne dnes (P54C): klasifikátor bez čtení modelem a žánr návrhu
 * na semínku 1. Návrh míče potřebuje Rapier – volající ho čeká napřed
 * (`loadRapier()`), jako každá cesta serveru.
 */

import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { classifyGenre } from '../../../src/play/genre/classify';

export interface Row { readonly id: string; readonly classify: string; readonly fallback: boolean; readonly draft: string | null; readonly cell: string | null; readonly error?: string }

/**
 * Věty P30 dev, které od T13 vědomě hrají jiný žánr než na startu (`start.json`): obrana před vlnou nepřátel je
 * obrana pruhů, jak plán chce (T7: s155, j08, h03). Jiná věta P30 dev se pohnout nesmí – drží to
 * `start.measure.ts` (`P54C_CHECK=1`) a pin v `src/play/genre/__tests__/classify.test.ts`.
 */
export const T13_MOVED: Readonly<Record<string, Pick<Row, 'classify' | 'draft' | 'cell'>>> = {
  s155: { classify: 'defense.default', draft: 'defense.default', cell: 'assembled.lanes' },
  h03: { classify: 'defense.default', draft: 'defense.default', cell: 'assembled.lanes' },
  j08: { classify: 'defense.default', draft: 'defense.default', cell: 'assembled.lanes' },
};

export function rowOf(id: string, text: string): Row {
  const ranking = classifyGenre(text, null);
  const top = ranking.ranked[0]!;
  const base = { id, classify: `${top.genre}.${top.mode}`, fallback: ranking.fallback };
  try {
    const meta = draftGameSpecWithMeta(text, 1);
    return { ...base, draft: meta.genre === null ? null : `${meta.genre.genre}.${meta.genre.mode}`, cell: meta.composition?.cellId ?? null };
  } catch (error) {
    return { ...base, draft: null, cell: null, error: (error as Error).message.slice(0, 160) };
  }
}
