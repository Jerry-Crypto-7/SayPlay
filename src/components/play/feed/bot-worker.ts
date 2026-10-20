/**
 * Worker, který spočte náhled robota pro hru publikovanou bez něj (P54A T4).
 *
 * Hry publikované před P54A `preview` nemají a `runBot` stojí na hlavním
 * vlákně 21–685 ms (naměřeno 19. 10.) – telefon by při přednačtení souseda
 * zamrzl. Worker pustí týž `runBot(world)` jako kompilace na serveru, takže
 * náhled má týž hash jako ten uložený při publikaci.
 *
 * Logika sedí v `previewForWorld()` (čistá funkce, test ji volá přímo);
 * obsluha zprávy kolem ní je tenká, jako v `src/shape/mesh-worker.ts`.
 */

import type { ArcadeWorld } from '@/play/arcade/contract';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { previewOf } from '@/play/version/preview';
import type { FeedPreview } from '@/play/version/version';

export interface BotWorkerRequest {
  readonly versionId: string;
  readonly world: ArcadeWorld;
}

export type BotWorkerResponse = { readonly versionId: string; readonly preview: FeedPreview } | { readonly versionId: string; readonly error: string };

export async function previewForWorld(world: ArcadeWorld): Promise<FeedPreview> {
  if (worldHasPhysics(world)) await loadRapier();
  return previewOf(world, runBot(world));
}

export async function handleBotJob(request: BotWorkerRequest): Promise<BotWorkerResponse> {
  try {
    return { versionId: request.versionId, preview: await previewForWorld(request.world) };
  } catch (thrown) {
    return { versionId: request.versionId, error: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

/** Jen ta část `self`, kterou worker používá (knihovna `webworker` se s `dom` v jednom `tsconfig` nesnese). */
interface BotWorkerScope {
  postMessage(message: BotWorkerResponse): void;
  onmessage: ((event: { data: BotWorkerRequest }) => void) | null;
}

// Obsluha jen tam, kde `self` je worker – ne v okně, v Node ani v SSR.
const workerScope: BotWorkerScope | undefined =
  typeof self !== 'undefined' && typeof self.postMessage === 'function' && !('document' in self) ? (self as unknown as BotWorkerScope) : undefined;

if (workerScope !== undefined) {
  workerScope.onmessage = (event) => {
    void handleBotJob(event.data).then((response) => workerScope.postMessage(response));
  };
}
