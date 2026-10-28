/**
 * Anonymní id návštěvníka (P63 T5) pro návrat hráče v trychtýři: náhodné UUID v `localStorage`, žádná cookie, nic
 * odvozeného z hráče. Mimo hru – do specifikace, semínka ani hashe stavu nevstupuje. Úložiště zakázané nebo plné =
 * žádné id: id, které se mezi návštěvami nedrží, by každou návštěvu počítalo jako nového hráče.
 */

export const VISITOR_KEY = 'sayplay-visitor';

/** Tvar `crypto.randomUUID()` (v4, malá písmena); dveře událostí jiné id nepřijmou. */
export const VISITOR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface VisitorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Id z úložiště, nebo nové uložené; `null`, když úložiště nejde číst nebo zapsat. Nikdy nevyhodí. */
export function visitorId(storage: () => VisitorStorage): string | null {
  try {
    const store = storage();
    const stored = store.getItem(VISITOR_KEY);
    if (stored !== null && VISITOR_PATTERN.test(stored)) return stored;
    const created = crypto.randomUUID();
    store.setItem(VISITOR_KEY, created);
    return created;
  } catch {
    return null;
  }
}
