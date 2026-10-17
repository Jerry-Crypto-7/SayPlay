/**
 * Místo pro ducha (P37-0 T3, zapojení P37B T8): průhledný hrdina dřívějšího
 * běhu (kamaráda, nejlepšího), který hraje vedle hráče. Kresbu i zdroj dodala
 * stopa sociální smyčky (`Ghost.tsx`, `ghost-source.ts`, `GHOST.md`); zdroj
 * načte `ArcadePlay` (`loadGhost`) a stage ho podá scéně. Bez ducha slot
 * nekreslí nic – žádný objekt, žádný draw call, obraz i hash hry beze změny.
 *
 * **Každá hra má slot právě jeden**, jinak by se duch kreslil dvakrát. Žánr
 * s vlastní scénou ho drží u sebe: běžec, plošinovka, střelnice, hod, řízení,
 * aréna, souboj, načasování a rytmus. `World` ho kreslí jen poletování, které
 * vlastní scénu nemá. Úkol hraje v aréně, takže jeho slot je slot arény –
 * stanoviště (`quest/StationScene.tsx`) hrdinu nekreslí. Hlídá to
 * `__tests__/ghost-slot.test.tsx`.
 */

import type { ArcadeWorld } from '@/play/arcade/contract';

import { Ghost, type GhostLabel, type GhostPlacement } from './Ghost';
import { type GhostReplay, fetchGhost } from './ghost-source';
import type { ArcadeSession } from './session';

/**
 * Póza hrdiny ducha v jednom tiku: poloha v jednotkách jádra (jako `BODY.x/y/z`
 * ve stavu) a natočení kolem svislé osy v radiánech. Do metrů scény ji převádí
 * slot, protože každá scéna má převod jiný (`World` zrcadlí x, souboj stojí na ose z).
 */
export interface GhostPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

/** Zdroj ducha: póza v daném tiku hráčovy simulace; `null` = duch v tom tiku není (záznam skončil). */
export interface GhostSource {
  poseAt(tick: number): GhostPose | null;
}

/** Duch jedné hry: zdroj a štítek („Friend“ z odkazu výzvy, „Best run“ nejlepšího běhu). */
export interface ArcadeGhost {
  readonly source: GhostSource;
  readonly label: GhostLabel;
}

/** Duch v rozběhnuté hře; `dispose` uvolní jeho svět Rapieru, až hra skončí. */
export interface LoadedGhost extends ArcadeGhost {
  readonly source: GhostReplay;
}

/** Mezera mezi hrdinou a duchem, který stojí vedle něj (m). */
const BESIDE_GAP_M = 0.5;

/**
 * Souboj, načasování a rytmus mají v `z` hráče počítadlo (úderů, kol, not), ne dráhu:
 * duch tam stojí vedle hrdiny a jeho záznam říká jen, kdy kamarád skončil (zmizí).
 * `x`, `z` = místo hrdiny ve scéně (m), `along` = osa, podél které ho kamera vidí vedle sebe.
 */
export function besideHero(x: number, z: number, width: number, along: 'x' | 'z'): () => GhostPlacement {
  const step = width + BESIDE_GAP_M;
  const at: GhostPlacement = along === 'x' ? [x + step, 0, z, 0] : [x, 0, z - step, 0];
  return () => at;
}

export function GhostSlot({ ghost, session, place }: { readonly ghost?: ArcadeGhost; readonly session: ArcadeSession; readonly place?: (pose: GhostPose) => GhostPlacement }) {
  if (ghost === undefined) return null;
  return <Ghost source={ghost.source} session={session} label={ghost.label} place={place} />;
}

/** `bestDare.dareId` z detailu hry (P37C T2); odpověď je z hranice – bez řetězce není duch. */
async function bestDareOf(versionId: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(`/api/play/games/${encodeURIComponent(versionId)}`);
    if (!response.ok) return null;
    const { bestDare } = (await response.json()) as { bestDare?: { dareId?: unknown } | null };
    return typeof bestDare?.dareId === 'string' ? bestDare.dareId : null;
  } catch {
    return null;
  }
}

/**
 * Nejlepší běh, který stránka `/play/[id]` přečetla z úložiště (P50 T6), dostane
 * jen první načtení ducha – detail hry se po hydrataci nestahuje. Každé další
 * načtení (`undefined`) se zeptá znovu: id z HTML je staré jako stránka.
 */
export function bestOnce(fromPage: string | null | undefined): () => string | null | undefined {
  let left = fromPage;
  return () => {
    const best = left;
    left = undefined;
    return best;
  };
}

/**
 * Duch hry (`GHOST.md` krok 1–2): kamarád z odkazu `?dare=` má přednost; jeho
 * výzva bez běhu (starší, nad stropem) ustoupí nejlepšímu běhu hry. Žádný = `null`.
 * `known` = nejlepší běh ze stránky (`null` = hra žádný nemá); `undefined` = zeptat se dveří.
 */
export async function loadGhost(versionId: string, friendDare: string | null, world: ArcadeWorld, fetcher: typeof fetch = fetch, known?: string | null): Promise<LoadedGhost | null> {
  if (friendDare !== null) {
    const source = await fetchGhost(versionId, friendDare, world, fetcher);
    if (source !== null) return { source, label: 'friend' };
  }
  const best = known === undefined ? await bestDareOf(versionId, fetcher) : known;
  if (best === null || best === friendDare) return null;
  const source = await fetchGhost(versionId, best, world, fetcher);
  return source === null ? null : { source, label: 'best' };
}
