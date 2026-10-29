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
 *
 * P56B T12: snímek hry, kterou návštěvník hrál nebo vytvořil, přežije reload.
 * Hra ho uloží po prvních snímcích (`KeepFrame`, i na své stránce mimo feed),
 * odchod z karty ho přepíše; feed je po načtení obnoví (`restore`) do IndexedDB
 * nejvýš 20 nejnovějších. Úložiště, které selže, karta nepozná – zůstane `/og`.
 */

import { type RootState, useFrame } from '@react-three/fiber';
import { useRef } from 'react';

import thumbs from './feed-thumbs.json';

export const SNAPSHOTS = 20;

/** Trvalé úložiště snímků; čtení ani zápis nikdy nevyhodí. */
export interface FrameStore {
  save(versionId: string, blob: Blob): Promise<void>;
  /** Uložené snímky od nejstaršího. */
  load(): Promise<readonly (readonly [versionId: string, blob: Blob])[]>;
}

interface StoredFrame {
  readonly versionId: string;
  readonly blob: Blob;
  readonly at: number;
}

const DB = { name: 'sayplay-frames', store: 'frames', version: 1 } as const;

function openFrames(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB.name, DB.version);
    request.onupgradeneeded = () => request.result.createObjectStore(DB.store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** Snímky v IndexedDB prohlížeče; drží `limit` nejnovějších. Bez IndexedDB (server, zakázané úložiště) nic neuloží. */
export function indexedFrames(limit = SNAPSHOTS): FrameStore {
  return {
    async save(versionId, blob) {
      try {
        const db = await openFrames();
        try {
          const tx = db.transaction(DB.store, 'readwrite');
          const store = tx.objectStore(DB.store);
          store.put({ versionId, blob, at: Date.now() } satisfies StoredFrame, versionId);
          const all = store.getAll();
          all.onsuccess = () => {
            const frames = (all.result as StoredFrame[]).sort((a, b) => a.at - b.at);
            for (const old of frames.slice(0, Math.max(0, frames.length - limit))) store.delete(old.versionId);
          };
          await finished(tx);
        } finally {
          db.close();
        }
      } catch {
        // Plný disk, anonymní okno, žádné IndexedDB: snímek zůstane jen do reloadu.
      }
    },
    async load() {
      try {
        const db = await openFrames();
        try {
          const tx = db.transaction(DB.store, 'readonly');
          const all = tx.objectStore(DB.store).getAll();
          await finished(tx);
          return (all.result as StoredFrame[]).sort((a, b) => a.at - b.at).map((frame) => [frame.versionId, frame.blob] as const);
        } finally {
          db.close();
        }
      } catch {
        return [];
      }
    },
  };
}

/** Uloží snímek hry přes reload; selhání úložiště spolkne. */
export async function keepFrame(versionId: string, blob: Blob, store: FrameStore = indexedFrames()): Promise<void> {
  try {
    await store.save(versionId, blob);
  } catch {
    // Jako `indexedFrames`: karta bez uloženého snímku ukáže `/og`.
  }
}

export interface SnapshotCache {
  /** Snímek hry, ze které hráč právě odešel; vrátí jeho URL a uloží ho přes reload. */
  put(versionId: string, blob: Blob): string;
  get(versionId: string): string | undefined;
  /** Snímky z dřívějších návštěv (P56B T12) jako starší než dnešní odchody; vrátí, kolik jich přibylo. */
  restore(): Promise<number>;
  readonly size: number;
}

const OBJECT_URLS = { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (href: string) => URL.revokeObjectURL(href) };

export function createSnapshotCache(limit = SNAPSHOTS, urls: { create(blob: Blob): string; revoke(href: string): void } = OBJECT_URLS, store: FrameStore = indexedFrames(limit)): SnapshotCache {
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
      void keepFrame(versionId, blob, store);
      return href;
    },
    get: (versionId) => shots.get(versionId),
    async restore() {
      let frames: Awaited<ReturnType<FrameStore['load']>>;
      try {
        frames = await store.load();
      } catch {
        return 0;
      }
      const missing = frames.filter(([id]) => !shots.has(id));
      const restored = missing.slice(Math.max(0, missing.length - (limit - shots.size)));
      const today = [...shots];
      shots.clear();
      for (const [id, blob] of restored) shots.set(id, urls.create(blob));
      for (const [id, href] of today) shots.set(id, href);
      return restored.length;
    },
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
 *
 * Ve VR snímek není (P67 T14): snímek navíc mimo snímek relace nemá pózy
 * ovladačů, paprsek v něm na chvíli z tlačítka panelu sjede a spoušť stisknutá
 * právě teď se ztratí (e2e `vr-lobby`); plátno relace obraz brýlí stejně nenese.
 */
export function captureFrame(state: Pick<RootState, 'advance' | 'gl'>): Promise<Blob | null> {
  if (state.gl.xr.isPresenting) return Promise.resolve(null);
  try {
    state.advance(performance.now(), false);
  } catch {
    // Snímek navíc běží uprostřed úklidu karty; chyba scény, která odchází, nesmí shodit feed – karta zůstane bez snímku.
    return Promise.resolve(null);
  }
  return new Promise((resolve) => state.gl.domElement.toBlob(resolve, 'image/jpeg', 0.8));
}

/** Kolik snímků hra vykreslí, než se její snímek uloží: díly sady stojí a hrdina je v záběru. */
const KEEP_AFTER_FRAMES = 30;

/**
 * Snímek hry po prvních snímcích (P56B T12), ne až při odchodu z karty: vytvořená hra se hraje na své
 * stránce, kam odchod z karty feedu nedosáhne. Snímek navíc v samostatném úkolu – `captureFrame`
 * uvnitř smyčky by kreslil snímek ve snímku.
 */
export function KeepFrame({ versionId }: { readonly versionId: string }): null {
  const frames = useRef({ versionId, count: 0 });
  useFrame((state) => {
    if (frames.current.versionId !== versionId) frames.current = { versionId, count: 0 };
    frames.current.count += 1;
    if (frames.current.count !== KEEP_AFTER_FRAMES) return;
    window.setTimeout(() => {
      void captureFrame(state).then((blob) => (blob === null ? undefined : keepFrame(versionId, blob)));
    });
  });
  return null;
}

const CURATED: ReadonlySet<string> = new Set(thumbs);

/** Obrázek nenavštívené karty: snímek kurátorské hry na výšku a na šířku, jinak obrázek odkazu. */
export function cardImage(versionId: string): { readonly portrait: string; readonly landscape: string } {
  if (CURATED.has(versionId)) return { portrait: `/feed-thumbs/${versionId}-p.webp`, landscape: `/feed-thumbs/${versionId}-l.webp` };
  const og = `/api/play/games/${versionId}/og`;
  return { portrait: og, landscape: og };
}
