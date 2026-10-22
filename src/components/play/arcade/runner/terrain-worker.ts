/**
 * Worker, který postaví terén kola běžce mimo hlavní vlákno (P56C T18). Logika je
 * v `runTerrainJob()` (`terrain.ts`, test ji volá přímo); obsluha zprávy je tenká,
 * jako v `feed/bot-worker.ts`.
 */

import { type TerrainJob, type TerrainReply, runTerrainJob, transferablesOf } from './terrain';

/** Jen ta část `self`, kterou worker používá (knihovna `webworker` se s `dom` v jednom `tsconfig` nesnese). */
interface TerrainWorkerScope {
  postMessage(message: TerrainReply, transfer: Transferable[]): void;
  onmessage: ((event: { data: TerrainJob }) => void) | null;
}

// Obsluha jen tam, kde `self` je worker – ne v okně, v Node ani v SSR.
const workerScope: TerrainWorkerScope | undefined =
  typeof self !== 'undefined' && typeof self.postMessage === 'function' && !('document' in self) ? (self as unknown as TerrainWorkerScope) : undefined;

if (workerScope !== undefined) {
  workerScope.onmessage = (event) => {
    const reply = runTerrainJob(event.data);
    workerScope.postMessage(reply, 'terrain' in reply ? transferablesOf(reply.terrain) : []);
  };
}
