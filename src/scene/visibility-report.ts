import type { RepresentationEvidence } from '@/worldstream/scene-metrics';

import type { SceneSpec } from './spec';

export interface VisualObservation {
  stableId: string; built: boolean; loaded: boolean; inFrame: boolean;
  screenPixels: number; unoccludedSamples: number; samples: number;
}

/** Diagnostic minimum; below it the instance is too small to be judged, not proven absent. */
const LEGIBLE_PIXELS = 24;

/**
 * Prompt → požadavek → instance → obraz, se stavem místo slovního hodnocení.
 *
 * **Recognizable potřebuje výslovný lidský úsudek**; projekce ho nezaloží.
 *
 * Co k tomu P20 A3 přidalo:
 *
 * - **Každá reprezentace hlásí kontakt, kolizi a počty** (`evidence`, ze
 *   `sceneMetrics`). Bez toho report tvrdil „loaded" o objektu, který visel
 *   ve vzduchu nebo prorůstal stěnou, a nebylo to z čeho poznat.
 * - **Důležitý objekt navíc zakrytí a velikost v obraze.** Hlavní požadavek a
 *   hrdinská role dostanou `occlusion` a `screenPixels` jako pojmenovaná pole,
 *   ne jako něco, co si čtenář má dopočítat z `observation`.
 * - **Nejvýše jedno cílené opravné kolo na objekt.** Druhé selhání se vykáže
 *   (`reported`), nespustí další kolo. Nekonečné přerámovávání jednoho objektu
 *   je přesně to, co z diagnostiky dělá ladění podle obrázku.
 */
export function visibilityReport(spec: SceneSpec, observations: readonly VisualObservation[],
  expected: readonly { description: string; instanceIds: readonly string[] }[] = [],
  judgments: Readonly<Partial<Record<string, boolean>>> = {},
  evidence: readonly RepresentationEvidence[] = [],
  repairRounds: Readonly<Partial<Record<string, number>>> = {}) {
  const byId = new Map(observations.map(item => [item.stableId,item]));
  const contactById = new Map(evidence.map(item => [item.stableId,item]));
  const planned = new Set(spec.instances.map(item => item.stableId));
  const heroes = new Set(spec.instances.filter(item => item.role === 'hero').map(item => item.stableId));
  const main = new Set(spec.requirements.filter(item => item.priority === 'main').flatMap(item => item.instanceIds));
  const requirements = [...spec.requirements.filter(r => r.polarity === 'required'), ...expected];
  return requirements.map(requirement => ({ description: requirement.description,
    instances: requirement.instanceIds.map(stableId => {
      const observed = byId.get(stableId);
      const contact = contactById.get(stableId);
      const status = !planned.has(stableId) ? 'absent' : !observed?.built ? 'planned'
        : !observed.loaded ? 'built' : !observed.inFrame || observed.unoccludedSamples === 0 || observed.screenPixels < LEGIBLE_PIXELS ? 'loaded'
        : judgments[stableId] === true ? 'recognizable' : 'visible';
      const important = heroes.has(stableId) || main.has(stableId);
      const rounds = repairRounds[stableId] ?? 0;
      const solved = status === 'recognizable' || (status === 'visible' && judgments[stableId] !== false);
      // Kolo se počítá i tam, kde se objekt mezitím spravil — jinak by se
      // z „spravilo se" a „nikdy se nezkoušelo" stala tatáž věta.
      const exhausted = rounds >= 1 && !solved;
      const suggestion = status === 'absent' ? 'Restore the omitted requirement in the semantic plan.'
        : status === 'planned' ? 'Build this instance.' : status === 'built' ? 'Load its representation.'
        : status === 'loaded' ? 'Inspect framing or occlusion for this instance.'
        : judgments[stableId] === false ? 'Revise this representation; its identity was not recognized.' : null;
      return { stableId, status, recognition: judgments[stableId] ?? 'unreviewed',
        observation: observed ?? null,
        // Kontakt a počty za každou reprezentaci, i za tu, kterou kamera
        // neviděla: objekt bez kusu je jiná vada než objekt mimo záběr.
        contact: contact
          ? { instances: contact.instances, unsupported: contact.unsupported, collisions: contact.collisions }
          : null,
        important,
        // Zakrytí a velikost jsou pojmenované jen u důležitého objektu. Jinde
        // by to byl šum: prkno v pozadí se smí ztratit za stolem.
        occlusion: important && observed && observed.samples > 0
          ? { samples: observed.samples, occluded: observed.samples - observed.unoccludedSamples }
          : null,
        screenPixels: important ? observed?.screenPixels ?? null : null,
        repairRounds: rounds,
        repair: exhausted ? null : suggestion,
        reported: exhausted ? `One targeted repair round already ran; the instance is still ${status}.` : null };
    }),
  }));
}
