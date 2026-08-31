'use client';

/**
 * `/dev/mesh-budget` — stránka, na které se měří cena meshingu (P13 vlna 1 T5).
 *
 * ## Proč to je stránka produktu, a ne jen spec
 *
 * `playwright.config.ts` říká, proč se testuje **produkční build**: „dev server
 * má jiný modulový graf a jiné chování dynamic importů, takže by ověřoval něco
 * jiného, než co se nasadí." Přesně to platí pro rozpočet. Kdyby si spec moduly
 * z `src/shape/**` přeložil sám a naservíroval je přes `page.route()`, měřil by
 * nezminifikovaný kód v jiném modulovém grafu — tedy **jiný program**, a
 * naměřené milisekundy by o produktu nevypovídaly.
 *
 * Cenu proto počítá `createMeshClient()`, což je tentýž klient a tentýž
 * `new Worker(new URL('./mesh-worker.ts', import.meta.url))`, jaký potrubí
 * použije ve vlně 3. Stránka nic nevykresluje a nemá plátno: meshing je čistě
 * procesorová práce nad `Float32Array` a WebGL do měření nepatří.
 *
 * ## Proč tu není `notFound()` v produkci
 *
 * Nabízí se stránku v produkčním buildu schovat. Nešlo by to: e2e sada **je**
 * produkční build (`next build && next start`), takže by se schovala i před
 * měřením a rozpočet by se dal změřit jen v prostředí, které se nenasazuje.
 * Cena je jedna prázdná adresa navíc, na kterou nikdo neodkazuje — táž volba
 * jako u `/target`.
 */

import { useEffect, useState } from 'react';

import { createMeshClient } from '@/shape/mesh-client';
import { meshShapeProgram } from '@/shape/surface-nets';
import { GALLERY, GALLERY_SEED } from '../../../../evals/shape/gallery';
import {
  REFERENCE_BOUNDS,
  REFERENCE_SEED,
  referenceProgram,
} from '../../../../evals/shape/reference-program';

/** Cena jednoho tvaru galerie. Bez workeru a **bez rozpočtu**, viz níž. */
export interface GallerySample {
  readonly id: string;
  readonly ms: number;
  readonly triangles: number;
  readonly nodes: number;
}

/** Co si spec ze stránky odnese. Jeden běh jedné mřížky. */
export interface MeshBudgetSample {
  readonly resolution: number;
  /** Čas naměřený **uvnitř workeru**, bez ceny předání bufferu. */
  readonly workerMs: number;
  /** Čas od objednávky po hotový mesh na hlavním vlákně, tedy včetně předání. */
  readonly roundTripMs: number;
  readonly vertices: number;
  readonly triangles: number;
}

declare global {
  interface Window {
    __meshBudget?: {
      /** Změří jednu mřížku. Volá se opakovaně, zahřátí JIT řídí spec. */
      measure: (resolution: number) => Promise<MeshBudgetSample>;
      /** Kolik uzlů referenční program má — kontrola, že se měří, co se čeká. */
      nodeCount: () => number;
      /**
       * Týž tvar spočítaný **na hlavním vlákně**, bez workeru a bez předání
       * bufferu. Není to způsob, jak produkt meshuje — je to diagnostika:
       * odpovídá na otázku, jestli za rozdílem proti Node stojí worker, nebo
       * samo V8 v prohlížeči. Rozdíl mezi `measure` a tímhle je cena workeru.
       */
      measureOnMainThread: (resolution: number) => number;
      /**
       * Cena **všech dvanácti tvarů galerie**, ne jen referenčního programu.
       *
       * Strop `MESH_DETAIL.high.maxMs` vznikl z jediného referenčního tvaru se
       * ~20 uzly a na galerii ho tři až šest tvarů přetahovalo — naměřeno
       * 31. 8. 2026. Tohle měření je důvod, proč se strop zvedl z 900 na 2 600;
       * odůvodnění je u `MESH_DETAIL`. Zůstává tu proto, aby se příští změna
       * čísla zase neopřela o jediný tvar.
       *
       * Měří se **na hlavním vlákně a mimo worker**, tedy mimo rozpočet: kdyby
       * to šlo přes `client.mesh()`, dnešní strop by dražší tvary odmítl dřív,
       * než by řekly, kolik stojí — a to je přesně ta hodnota, která se hledá.
       * Poměr worker/hlavní vlákno dává `measure` proti `measureOnMainThread`
       * nad týmž referenčním tvarem.
       */
      measureGallery: (resolution: number) => readonly GallerySample[];
    };
  }
}

export default function MeshBudgetPage(): React.JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Jeden klient na celou stránku. Fronta v něm je sériová, takže se měření
    // mřížek nemůžou překrýt ani kdyby je spec pustil naráz.
    //
    // **`unbudgeted`, protože měřidlo nesmí soudit.** Report vede 64³ a 96³
    // schválně bez rozsudku, jenže `budgetFor()` je stejně soudilo příčkou
    // `high` (48³) a worker vlastní měření odmítal — spec byl od 29. 8. 2026
    // červený na `mesh is 47680 triangles, above maxTriangles 32000`. Rozsudek
    // nad příčkami žebříku dělá **spec**, nad hotovým reportem, takže se tím
    // nikam neztratil; jen se přestal plést do jeho pořizování.
    const client = createMeshClient({ unbudgeted: true });
    const program = referenceProgram();

    window.__meshBudget = {
      nodeCount: () => program.nodes.length,
      measureOnMainThread: (resolution) => {
        const startedAt = performance.now();
        meshShapeProgram(program, REFERENCE_SEED, { resolution, bounds: REFERENCE_BOUNDS });
        return performance.now() - startedAt;
      },
      measureGallery: (resolution) =>
        GALLERY.map((item) => {
          const startedAt = performance.now();
          const mesh = meshShapeProgram(item.program, GALLERY_SEED, {
            resolution,
            bounds: item.program.targetBounds,
          });
          return {
            id: item.id,
            ms: performance.now() - startedAt,
            triangles: mesh.triangleCount,
            nodes: item.program.nodes.length,
          };
        }),
      measure: async (resolution) => {
        // `performance.now()` je tady v pořádku: měření není replay cesta a
        // žádná z těch hodnot nevstupuje do hashovaného stavu.
        const startedAt = performance.now();
        const mesh = await client.mesh({
          program,
          sessionSeed: REFERENCE_SEED,
          resolution,
          bounds: REFERENCE_BOUNDS,
        });
        return {
          resolution,
          workerMs: mesh.elapsedMs,
          roundTripMs: performance.now() - startedAt,
          vertices: mesh.vertexCount,
          triangles: mesh.triangleCount,
        };
      },
    };
    setReady(true);

    return () => {
      delete window.__meshBudget;
      client.dispose();
    };
  }, []);

  return (
    <main data-testid="mesh-budget-root" data-ready={ready ? 'yes' : 'no'}>
      <p>Mesh budget harness. Nothing to see — the numbers go to the report.</p>
    </main>
  );
}
