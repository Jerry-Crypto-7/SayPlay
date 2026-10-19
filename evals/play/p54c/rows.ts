/**
 * Věta → kam padne dnes (P54C): klasifikátor bez čtení modelem a žánr návrhu
 * na semínku 1. Návrh míče potřebuje Rapier – volající ho čeká napřed
 * (`loadRapier()`), jako každá cesta serveru.
 */

import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { classifyGenre } from '../../../src/play/genre/classify';

export interface Row { readonly id: string; readonly classify: string; readonly fallback: boolean; readonly draft: string | null; readonly cell: string | null; readonly error?: string }

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
