/**
 * Obrázek karty feedu, která zrovna nehraje (P54A T8).
 *
 * Karta, ze které hráč odešel, ukazuje snímek své scény: `StageHost` ho
 * zachytí ve chvíli odchodu (`captureFrame`) a feed ho drží tady – nejvýš 20
 * `objectURL` (LRU podle odchodu), vyřazený se uvolní `revokeObjectURL`, jinak
 * by telefon po desítkách přechodů držel desítky obrázků v paměti.
 * Nenavštívená karta: kurátorská hra má snímek z `scripts/p37c/feed-thumbs.mjs`
 * (`public/feed-thumbs/<id>-{p,l}.webp`), ostatní obrázek odkazu (`…/og`)
 * nad plakátem v tónu nálady.
 */

import type { RootState } from '@react-three/fiber';

import thumbs from './feed-thumbs.json';

export const SNAPSHOTS = 20;

export interface SnapshotCache {
  /** Snímek hry, ze které hráč právě odešel; vrátí jeho URL. */
  put(versionId: string, blob: Blob): string;
  get(versionId: string): string | undefined;
  readonly size: number;
}

const OBJECT_URLS = { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (href: string) => URL.revokeObjectURL(href) };

export function createSnapshotCache(limit = SNAPSHOTS, urls: { create(blob: Blob): string; revoke(href: string): void } = OBJECT_URLS): SnapshotCache {
  // Pořadí vložení v `Map` je fronta: nejstarší odchod první.
  const shots = new Map<string, string>();
  return {
    put(versionId, blob) {
      const old = shots.get(versionId);
      if (old !== undefined) {
        shots.delete(versionId);
        urls.revoke(old);
      }
      const href = urls.create(blob);
      shots.set(versionId, href);
      for (const [id, oldest] of shots) {
        if (shots.size <= limit) break;
        shots.delete(id);
        urls.revoke(oldest);
      }
      return href;
    },
    get: (versionId) => shots.get(versionId),
    get size() {
      return shots.size;
    },
  };
}

/**
 * Scéna, která v plátně právě je, jako obrázek. Bez `preserveDrawingBuffer`
 * platí obsah plátna jen v úkolu, který ho vykreslil, a při odchodu z karty
 * už žádný další snímek její scény nepřijde (scénu další hry vymění tentýž
 * commit) – proto jeden snímek navíc hned teď a `toBlob` v témž úkolu
 * (kopie plátna je synchronní, kódování až potom).
 */
export function captureFrame(state: Pick<RootState, 'advance' | 'gl'>): Promise<Blob | null> {
  try {
    state.advance(performance.now(), false);
  } catch {
    // Snímek navíc běží uprostřed úklidu karty; chyba scény, která odchází, nesmí shodit feed – karta zůstane bez snímku.
    return Promise.resolve(null);
  }
  return new Promise((resolve) => state.gl.domElement.toBlob(resolve, 'image/jpeg', 0.8));
}

const CURATED: ReadonlySet<string> = new Set(thumbs);

/** Obrázek nenavštívené karty: snímek kurátorské hry na výšku a na šířku, jinak obrázek odkazu. */
export function cardImage(versionId: string): { readonly portrait: string; readonly landscape: string } {
  if (CURATED.has(versionId)) return { portrait: `/feed-thumbs/${versionId}-p.webp`, landscape: `/feed-thumbs/${versionId}-l.webp` };
  const og = `/api/play/games/${versionId}/og`;
  return { portrait: og, landscape: og };
}
