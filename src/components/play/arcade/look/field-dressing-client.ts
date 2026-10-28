/**
 * Kulisy hrací plochy na hlavním vlákně (P62 T4-R1): worker, jeho fronta a hotová místa kusů.
 *
 * T4 pustil worker až při montáži scény (`FieldDressing`). Od té chvíle hlavní vlákno staví scénu
 * a kreslí první snímek a worker se rozjede i odpoví až v jeho mezerách: naměřeno 27. 10. (build,
 * headless Chromium) se worker zkonstruovaný 2–3 s před prvním snímkem spustil až 0,7–0,9 s po něm
 * a kusy naskočily 4–6 s po prvním snímku na desktopu i na Pixel 7 s CPU 4×. Teď si je `ArcadePlay`
 * vyžádá už při hydrataci stránky (`prefetchFieldDressing`, týž vzor jako `PrefetchPhysics`), kdy
 * hlavní vlákno ještě mezery má; hotová místa leží v `fieldPiecesNow` a `FieldDressing` je postaví
 * hned při montáži, spolu se zbytkem scény. Místa počítá týž worker týmž během robota jako v T4.
 * A/B 27. 10. (medián 15 načtení, od prvního snímku): Pixel 7 CPU 4× +8,2 s → −2,3 s (kusy stojí
 * už v montáži), desktop +5,3 s → +1,4 s – tam montáž scény přijde 0,3 s po hydrataci, dřív, než
 * worker doběhne, a první snímek sám drží hlavní vlákno 1,6–2,2 s.
 *
 * Bez three a R3F: modul táhne `ArcadePlay` do první dávky skriptů stránky.
 */

import { baseControlOf } from '@/play/arcade/addons';
import type { ArcadeWorld } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';

import type { FieldPiece } from './field-dressing';
import type { FieldWorkerRequest, FieldWorkerResponse } from './field-dressing-worker';

/** Ovládání se zdobenou plochou (`frameOf` ve workeru): aréna, souboj a střelnice. */
const DRESSED: ReadonlySet<string> = new Set(['move_free', 'fight', 'shooter']);

let worker: Worker | null = null;
let jobId = 0;
const waiting = new Map<number, (pieces: readonly FieldPiece[]) => void>();
const jobs = new WeakMap<ArcadeWorld, WeakMap<Look, Promise<readonly FieldPiece[]>>>();
const done = new WeakMap<ArcadeWorld, WeakMap<Look, readonly FieldPiece[]>>();

/**
 * Pošle úlohu workeru. První jede ve jménu nového workeru (`name`, JSON 4–7 kB), ne zprávou: zprávu
 * poslanou před startem workeru mu předá až hlavní vlákno a to je od montáže scény do konce prvního
 * snímku plné (trace 27. 10.: worker stál od 594 ms, úlohu dostal v 2525 ms). Další úlohy (feed) zprávou.
 */
function send(request: FieldWorkerRequest): void {
  if (worker !== null) {
    worker.postMessage(request);
    return;
  }
  // `new URL(..., import.meta.url)` webpack pozná a worker zabalí (vzor `feed/preview.ts`).
  const created = new Worker(new URL('./field-dressing-worker.ts', import.meta.url), { type: 'module', name: JSON.stringify(request) });
  created.onmessage = (event: MessageEvent<FieldWorkerResponse>) => {
    waiting.get(event.data.id)?.(event.data.pieces);
    waiting.delete(event.data.id);
  };
  created.onerror = () => {
    for (const resolve of waiting.values()) resolve([]);
    waiting.clear();
    worker = null;
  };
  worker = created;
}

/** Kusy hrací plochy hry; worker je spočte jednou na svět a sadu. Bez workeru (Node, SSR) žádné. */
export function fieldPiecesOf(world: ArcadeWorld, look: Look): Promise<readonly FieldPiece[]> {
  const byLook = jobs.get(world) ?? new WeakMap<Look, Promise<readonly FieldPiece[]>>();
  jobs.set(world, byLook);
  const known = byLook.get(look);
  if (known !== undefined) return known;
  const job = new Promise<readonly FieldPiece[]>((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve([]);
      return;
    }
    jobId += 1;
    waiting.set(jobId, (pieces) => {
      const ready = done.get(world) ?? new WeakMap<Look, readonly FieldPiece[]>();
      done.set(world, ready);
      ready.set(look, pieces);
      resolve(pieces);
    });
    send({ id: jobId, world, look });
  });
  byLook.set(look, job);
  return job;
}

/** Kusy, které worker už vrátil; `undefined` = ještě počítá, nebo o ně nikdo nepožádal. */
export function fieldPiecesNow(world: ArcadeWorld, look: Look): readonly FieldPiece[] | undefined {
  return done.get(world)?.get(look);
}

/**
 * Hra se zdobenou plochou: požádá worker o kusy hned, jak stránka zná svět a sadu. Volá se
 * v renderu (jako `prefetchRapier`); druhé volání nic nepošle, na serveru (bez `Worker`) taky ne.
 * Na hlavním vlákně stojí jen kopie světa do zprávy (0,2–0,7 ms nad hrami testu T4).
 */
export function prefetchFieldDressing(world: ArcadeWorld, look: Look): void {
  if (DRESSED.has(baseControlOf(world.control).id)) void fieldPiecesOf(world, look);
}
