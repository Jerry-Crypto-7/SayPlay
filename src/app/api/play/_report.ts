/**
 * Dvojník verifikátoru (P23-C, než dorazí P23-A): zpráva o kvalitě bez
 * keypointů. Svědka bere z kompilace, replay nekontroluje, rozpočty počítá
 * ze `sim`. `stub: true` říká čtenáři, že zpráva nic neověřila – kontrakt
 * to pole nemá, proto je jen na tomhle rozšířeném typu.
 */

import type { CompiledGame, QualityReport } from '@/play/contracts';

export type StubQualityReport = QualityReport & { readonly stub: true };

export function stubReport(compiled: CompiledGame): StubQualityReport {
  const sim = compiled.blueprint.world.sim as { readonly entities: object; readonly rules: object };
  return {
    specHash: compiled.specHash,
    worldHash: compiled.worldHash,
    keypoints: [],
    witness: { certified: compiled.winsAtTick !== null, winsAtTick: compiled.winsAtTick },
    replayEqual: true,
    budgets: {
      entities: Object.keys(sim.entities).length,
      rules: Object.keys(sim.rules).length,
      triangles: null,
    },
    publishEligible: true,
    stub: true,
  };
}
