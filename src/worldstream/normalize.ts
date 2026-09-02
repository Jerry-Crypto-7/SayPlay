/**
 * **Normalizér: obal se posune, data meshe se nesáhne** (P15 T19, §13.2).
 *
 * Mesh z workeru je v prostoru tvaru — tam, kde ho model napsal. Slot ho chce
 * mít ve svém prostoru. Ten rozdíl se dá překlenout dvěma způsoby a jenom
 * jeden z nich je správný:
 *
 * 1. **Přepsat vrcholy.** Projít `positions`, každý bod přenásobit. Vypadá to
 *    nevinně a je to nejhorší možná volba: hash artefaktu přestane odpovídat
 *    programu, ze kterého vznikl, takže **kontrolní přečtení (`verifyAttached`)
 *    ztratí smysl** — porovnávalo by přepsaná data proti sobě. A cena se platí
 *    znovu při každém rozlišení.
 * 2. **Popsat rozdíl transformací obalu.** Data zůstanou bit po bitu tím, co
 *    spočítal worker, a hýbe se rám kolem nich. To dělá tenhle soubor.
 *
 * Proto je **jediné, co odsud leze, transformace** — a typové pole s poli
 * z výsledku odcházejí jako **tytéž objekty**, ne kopie. Test to tak i soudí,
 * porovnáním referencí: kdyby někdo někdy sáhl po variantě 1, nestačí, aby se
 * čísla shodovala.
 *
 * ## Rezerva workeru se odečítá, protože ji worker přidal
 *
 * `handleMeshJob` si k objednanému kvádru přidá jednu buňku rezervy, aby tvar
 * napsaný přes svůj obal nezmizel. Naměřený kvádr je tedy zákonitě o kus
 * větší než objednaný a **není to vada** — normalizér proto počítá vždycky
 * z naměřeného, nikdy z objednaného, a slot dostane rám kolem toho, co
 * doopravdy vzniklo.
 */

import type { Bounds3, Vec3 } from '@/shape/types';
import type { MeshResult } from '@/shape/mesh-client';

import { boundsCenter, boundsExtent, type SlotTransform } from './slots';

export interface NormalizedMesh {
  /** Rám kolem meshe: měřítko a posun, **žádná rotace** (§13.2). */
  readonly transform: SlotTransform;
  /** Kvádr, do kterého mesh po transformaci padne. */
  readonly worldBounds: Bounds3;
  /** **Tytéž objekty, jaké přišly z workeru.** Ne kopie, ne přepočet. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** Podíl, který nikdy nevrátí nulu ani nekonečno u zploštělé osy. */
function ratio(target: number, source: number): number {
  if (source === 0) return 1;
  const value = target / source;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Rám, který mesh přesadí do cílového kvádru.
 *
 * Zarovnává **středy**, ne rohy: střed je jediný bod kvádru, který nezávisí
 * na tom, kterým směrem tvar ze svého obalu vyleze. Zarovnání rohu by objekt
 * posunulo pokaždé, když se změní rozlišení, protože rezerva jedné buňky je
 * v hrubé mřížce jinak velká než v jemné — a §13.2 dělá z transformace slotu
 * invariant, který se mezi příčkami hýbat nesmí.
 */
export function normalizeToBounds(result: MeshResult, target: Bounds3): NormalizedMesh {
  const source = result.bounds;
  const from = boundsExtent(source);
  const to = boundsExtent(target);

  const scale: Vec3 = [ratio(to[0], from[0]), ratio(to[1], from[1]), ratio(to[2], from[2])];

  const sourceCenter = boundsCenter(source);
  const targetCenter = boundsCenter(target);
  const translation: Vec3 = [
    targetCenter[0] - sourceCenter[0] * scale[0],
    targetCenter[1] - sourceCenter[1] * scale[1],
    targetCenter[2] - sourceCenter[2] * scale[2],
  ];

  return {
    transform: { scale, translation },
    worldBounds: {
      min: [
        source.min[0] * scale[0] + translation[0],
        source.min[1] * scale[1] + translation[1],
        source.min[2] * scale[2] + translation[2],
      ],
      max: [
        source.max[0] * scale[0] + translation[0],
        source.max[1] * scale[1] + translation[1],
        source.max[2] * scale[2] + translation[2],
      ],
    },
    // Bez `.slice()`, bez `Float32Array.from()`. Viz hlavička.
    positions: result.positions,
    normals: result.normals,
    indices: result.indices,
  };
}
