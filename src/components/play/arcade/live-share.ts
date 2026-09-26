import type { ArcadeWorld } from '@/play/arcade/contract';
import { type LivePatch, liveRemixSpec } from '@/play/arcade/live';
import type { GameSpecV1 } from '@/play/spec';

import type { LiveShare } from '../ShareButton';

/**
 * Sdílení po živých změnách (P29D T10): verze se specem, který změny nese,
 * publikovaná dnešní remix route (rodič zůstává v rodokmenu). `null` = běh
 * žádné změny nemá; `partial` = něco z běhu do odkazu nejde. Když nejde nic,
 * sdílí se hraná verze – kopie rodiče pod novým id by nebyla nová hra.
 * Výjimka = verzi se nepodařilo publikovat.
 */
export async function publishLive(
  versionId: string,
  spec: GameSpecV1,
  world: ArcadeWorld,
  patches: readonly LivePatch[],
  post: typeof fetch = fetch,
): Promise<LiveShare | null> {
  if (patches.length === 0) return null;
  const { spec: child, dropped } = liveRemixSpec(spec, world, patches);
  if (JSON.stringify(child) === JSON.stringify(spec)) return { versionId, partial: true };
  const response = await post(`/api/play/games/${versionId}/remix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: child }) });
  const body = (await response.json()) as { url?: unknown };
  if (!response.ok || typeof body.url !== 'string') throw new Error(`live version not published (${String(response.status)})`);
  return { versionId: body.url.split('/').at(-1) ?? versionId, partial: dropped > 0 };
}
