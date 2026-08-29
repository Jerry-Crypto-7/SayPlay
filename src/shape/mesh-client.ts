/**
 * Klient meshovacího workeru — hlavní vlákno si tudy objednává tvary.
 *
 * ## Jeden worker, fronta, žádná souběžnost
 *
 * Tvary chodí po jednom. Dva workery by běžely paralelně a hotový mesh by
 * dorazil dřív, jenže **pořadí je vlastnost produktu**: `priority` v programu
 * říká, co má porotce vidět první. Fronta, která se řídí prioritou, je proto
 * víc než propustnost — a druhé jádro stejně potřebuje prohlížeč na kreslení.
 *
 * ## Proč se na hlavní vlákno nikdy neuteče samo
 *
 * `createMeshClient()` bez workeru **selže**, místo aby tiše počítalo tady.
 * Tichý ústup je ta nejdražší varianta ze všech: v testu i na vývojářském
 * stroji všechno funguje, a na porotcově notebooku scéna zamrzne na dvě
 * sekundy bez jediné stopy v logu. Kdo tenhle ústup chce, řekne si o něj
 * `allowMainThread` a ví, co dělá.
 */

import { handleMeshJob, type MeshJobRequest, type MeshJobResponse } from './mesh-worker';
import type { Bounds3, ShapeProgram } from './types';

/** To, co si o tvar říká zbytek produktu. `jobId` doplní klient. */
export interface MeshOrder {
  readonly program: Pick<ShapeProgram, 'nodes' | 'root' | 'shapeId'>;
  readonly sessionSeed: number;
  readonly resolution: number;
  readonly bounds: Bounds3;
}

export interface MeshResult {
  readonly shapeId: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly bounds: Bounds3;
  readonly elapsedMs: number;
}

/** Minimum, které klient od workeru potřebuje. Test sem dosadí atrapu. */
export interface MeshWorkerLike {
  postMessage(message: MeshJobRequest): void;
  terminate(): void;
  onmessage: ((event: { data: MeshJobResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface MeshClientOptions {
  /**
   * Jak se worker vyrábí. Výchozí je `new Worker(new URL('./mesh-worker.ts', …))`,
   * což je zápis, kterému rozumí bundler a sám ten soubor zabalí.
   */
  readonly createWorker?: () => MeshWorkerLike;
  /** Povolit počítání na hlavním vlákně, když worker není. Výchozí `false`. */
  readonly allowMainThread?: boolean;
}

export interface MeshClient {
  /** Objedná tvar. Slib se splní hotovým meshem nebo odmítne s důvodem. */
  mesh(order: MeshOrder): Promise<MeshResult>;
  /** Kolik prací čeká ve frontě včetně té běžící. */
  readonly pending: number;
  /** Zavře worker. Nedoběhlé práce se odmítnou. */
  dispose(): void;
}

function defaultWorkerFactory(): MeshWorkerLike {
  // `new URL(..., import.meta.url)` je zápis, který webpack i turbopack poznají
  // a worker z něj zabalí. Řetězcová cesta by se nezabalila a v produkci by
  // vrátila 404 — bez chyby v konzoli, protože worker mlčí.
  return new Worker(new URL('./mesh-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as MeshWorkerLike;
}

interface QueueEntry {
  readonly request: MeshJobRequest;
  readonly shapeId: string;
  readonly resolve: (result: MeshResult) => void;
  readonly reject: (error: Error) => void;
}

export function createMeshClient(options: MeshClientOptions = {}): MeshClient {
  const factory = options.createWorker ?? defaultWorkerFactory;
  const queue: QueueEntry[] = [];
  let running: QueueEntry | null = null;
  let worker: MeshWorkerLike | null = null;
  let disposed = false;
  let nextJobId = 0;

  function ensureWorker(): MeshWorkerLike | null {
    if (worker !== null) return worker;
    if (typeof Worker === 'undefined' && options.createWorker === undefined) return null;

    worker = factory();
    worker.onmessage = (event) => finish(event.data);
    worker.onerror = (event) => {
      // Worker spadl jako celek. Běžící práce má důvod, fronta se rozjede dál
      // na novém workeru — jinak by jedna vada zastavila celý svět.
      const message = event instanceof Error ? event.message : 'mesh worker failed';
      const failed = running;
      running = null;
      worker?.terminate();
      worker = null;
      failed?.reject(new Error(message));
      pump();
    };
    return worker;
  }

  function finish(response: MeshJobResponse): void {
    const entry = running;
    running = null;
    if (entry === null || entry.request.jobId !== response.jobId) {
      // Odpověď na práci, o kterou už nikdo nestojí — po `dispose()` nebo po
      // pádu workeru. Zahodit ji je správně; splnit cizí slib by nebylo.
      pump();
      return;
    }

    if (response.ok) {
      entry.resolve({
        shapeId: entry.shapeId,
        positions: response.positions,
        normals: response.normals,
        indices: response.indices,
        vertexCount: response.vertexCount,
        triangleCount: response.triangleCount,
        bounds: response.bounds,
        elapsedMs: response.elapsedMs,
      });
    } else {
      entry.reject(new Error(response.error));
    }
    pump();
  }

  function pump(): void {
    if (disposed || running !== null) return;
    const next = queue.shift();
    if (next === undefined) return;

    running = next;
    const active = ensureWorker();
    if (active !== null) {
      active.postMessage(next.request);
      return;
    }

    if (!options.allowMainThread) {
      running = null;
      next.reject(
        new Error(
          'mesh worker unavailable: pass allowMainThread to accept a frozen frame instead',
        ),
      );
      pump();
      return;
    }

    // Vědomý ústup. Je synchronní, takže hlavní vlákno stojí — a právě proto
    // se sem nedá dostat omylem.
    finish(handleMeshJob(next.request).response);
  }

  return {
    mesh(order: MeshOrder): Promise<MeshResult> {
      if (disposed) return Promise.reject(new Error('mesh client is disposed'));
      nextJobId += 1;
      const request: MeshJobRequest = {
        jobId: `mesh-${nextJobId}`,
        nodes: order.program.nodes,
        root: order.program.root,
        sessionSeed: order.sessionSeed,
        resolution: order.resolution,
        bounds: order.bounds,
      };
      return new Promise<MeshResult>((resolve, reject) => {
        queue.push({ request, shapeId: order.program.shapeId, resolve, reject });
        pump();
      });
    },

    get pending(): number {
      return queue.length + (running === null ? 0 : 1);
    },

    dispose(): void {
      disposed = true;
      worker?.terminate();
      worker = null;
      const stopped = running;
      running = null;
      stopped?.reject(new Error('mesh client is disposed'));
      while (queue.length > 0) {
        queue.shift()?.reject(new Error('mesh client is disposed'));
      }
    },
  };
}
