/**
 * Rozpracované AI verze v prohlížeči (P27C T3): hráč, který odešel dřív, než
 * režie doběhla (smí trvat 270 s), se o hotové verzi dozví při návratu na
 * `/play` nebo na návrh. Úložiště je jen pomůcka – v anonymním okně nebo při
 * plném úložišti vyhodí výjimku a stránka musí fungovat dál bez něj.
 */

export const PENDING_KEY = 'play:pending-upgrades';
export const MAX_PENDING = 5;
export const PENDING_TTL_MS = 3_600_000;

export interface PendingUpgrade {
  readonly draftId: string;
  readonly sentence: string;
  readonly startedAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** `localStorage`, nebo `null`, když už samotný přístup k němu vyhodí (Safari private, zakázané cookies). */
function browserStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is PendingUpgrade {
  if (typeof value !== 'object' || value === null) return false;
  const { draftId, sentence, startedAt } = value as Record<string, unknown>;
  return typeof draftId === 'string' && /^[a-z0-9]{1,64}$/i.test(draftId) && typeof sentence === 'string' && typeof startedAt === 'number' && Number.isFinite(startedAt);
}

/** Uložené práce mladší než hodina, nejnovější první; cokoli nečitelného je prázdný seznam. */
export function pendingUpgrades(now = Date.now(), store: Store | null = browserStore()): PendingUpgrade[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(PENDING_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).filter((entry) => now - entry.startedAt < PENDING_TTL_MS && entry.startedAt <= now).slice(0, MAX_PENDING);
  } catch {
    return [];
  }
}

function save(entries: readonly PendingUpgrade[], store: Store | null): void {
  try {
    store?.setItem(PENDING_KEY, JSON.stringify(entries.slice(0, MAX_PENDING)));
  } catch {
    // Plné nebo zakázané úložiště: hráč jen nedostane připomínku.
  }
}

/** Zapamatuje práci; už uložená si nechá svůj začátek, aby ji návrat neomlazoval. */
export function rememberPending(entry: PendingUpgrade, now = Date.now(), store: Store | null = browserStore()): void {
  const kept = pendingUpgrades(now, store);
  if (kept.some((known) => known.draftId === entry.draftId)) return;
  save([entry, ...kept], store);
}

export function forgetPending(draftId: string, now = Date.now(), store: Store | null = browserStore()): void {
  save(
    pendingUpgrades(now, store).filter((entry) => entry.draftId !== draftId),
    store,
  );
}
