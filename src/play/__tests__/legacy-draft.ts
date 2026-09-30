/**
 * Návrh ze slov před P32B T2: ovládání z klíčových slov, jinak mřížka
 * archetypu. Nová hra od P32B jde přes žánr (`draftGameSpec`); šablony ovládání
 * a mřížky dál staví remix uložených legacy her (`draftForControl`), takže
 * testy jejich mechanik jdou přes tuhle cestu.
 */

import { draftForControl } from '../draft';
import { pickControl } from '../draft/controls';
import type { ControlId, GameSpecV1 } from '../spec';

export function legacyDraft(sentence: string, seed = 1, control: ControlId = pickControl(sentence.toLowerCase())?.control ?? 'tap_go'): GameSpecV1 {
  return draftForControl(sentence, control, seed) ?? (draftForControl(sentence, 'tap_go', seed) as GameSpecV1);
}
