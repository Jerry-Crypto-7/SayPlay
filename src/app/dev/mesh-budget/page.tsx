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
import {
  REFERENCE_BOUNDS,
  REFERENCE_SEED,
  referenceProgram,
} from '../../../../evals/shape/reference-program';

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
    };
  }
}

export default function MeshBudgetPage(): React.JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Jeden klient na celou stránku. Fronta v něm je sériová, takže se měření
    // mřížek nemůžou překrýt ani kdyby je spec pustil naráz.
    const client = createMeshClient();
    const program = referenceProgram();

    window.__meshBudget = {
      nodeCount: () => program.nodes.length,
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
