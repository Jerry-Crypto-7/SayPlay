/**
 * Přednačtení sousedů aktivní karty (P54A T8): karta +1, +2 a −1 má po
 * dosednutí hotové, co její hra stahuje a počítá, takže náhled robota
 * naskočí bez čekání na síť. Každá hra se zahřeje nejvýš jednou za stránku –
 * modely i Rapier mají vlastní cache v modulu, panoramata cache prohlížeče.
 */

import { envFor, seedOf } from '@/play/arcade/look/env';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { chaserModel, enemyModel, heroModel, propModels, riggedCharacter } from '@/play/arcade/models';
import { loadRapier } from '@/play/arcade/physics/world';

import { loadModel } from '../arcade/look/load';
import { loadRigged } from '../arcade/RiggedModel';
import { previewFor } from './preview';
import type { GameDetail } from './ReelCard';

const warmed = new Set<string>();

/** Obrázek stažený a dekódovaný předem; chyba (404, výpadek) nevadí – karta ho pak stáhne sama. */
export function decodeImage(src: string): void {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  image.decode().catch(() => undefined);
}

/** Hra souseda připravená předem: modely, panorama, Rapier, náhled robota a obrázek karty. */
export function warmGame(versionId: string, detail: GameDetail, cardImage: string): void {
  if (warmed.has(versionId)) return;
  warmed.add(versionId);
  decodeImage(cardImage);
  const { spec, arcade } = detail;
  // Postava s kostrou jde přes cache `RiggedModel`, ne jako model katalogu (P56B T3).
  for (const id of new Set([heroModel(spec), enemyModel(spec), chaserModel(spec), ...Object.values(propModels(spec))])) {
    const rig = riggedCharacter(id);
    void (rig === undefined ? loadModel(id) : loadRigged(rig.path));
  }
  const env = envFor(spec.theme, seedOf(versionId));
  decodeImage(env.low);
  decodeImage(env.url);
  if (arcade === undefined) return;
  if (worldHasPhysics(arcade)) void loadRapier().catch(() => undefined);
  if (detail.preview === undefined) void previewFor(versionId, undefined, arcade);
}
