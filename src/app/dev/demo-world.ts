/**
 * **Ruční blueprint pro vývojové adresy** (P15 T19b, sdílený od T23).
 *
 * Vznikl uvnitř `/dev/worldstream` a od `T23` ho čtou dvě stránky, takže bydlí
 * mimo obě. Kopie by se rozešly přesně ve chvíli, kdy jedna z nich přidá objekt
 * — a testy obou by pak měřily jiný svět, aniž by to na nich bylo vidět.
 *
 * ## Proč je vstup pevný a ne z modelu
 *
 * Otázky vývojových adres znějí „dostane se hrubý svět na plátno?" a „trefí
 * druhá věta objekt, na který porotce ukázal?". Ani jedna nesmí záviset na tom,
 * co model zrovna napsal. Že model takový dokument umí napsat, měří `T14`.
 *
 * Ukázková kompozice z promptu je nejlepší možný vstup: nese všechny tři
 * příčky, které hrubý svět umí obsadit — hrdinský tvar (`g3-reduced`), dva
 * různé řádky kompozice (`g2-rich`) a zbytek kusů jako kulisu.
 */

import { sealSimHash } from '@/ir/worlddoc';
import { repairEmission } from '@/model/repair';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import type { BlueprintOutcome, CompiledBlueprint } from '@/model/worldstream-repair';
import { blueprintSchema, type WorldstreamBlueprint } from '@/worldstream/schema';

/** Čtyři objekty, tři cesty ke hmotě, jeden hrdinský tvar. */
export const DEMO_BLUEPRINT: WorldstreamBlueprint = blueprintSchema.parse({
  version: 'worldstream-v1',
  sessionSeed: 4021,
  title: 'a hillside terrace of beehives behind a low drystone wall',
  intent: EXAMPLE_PLAN.intent,
  world: sealSimHash(repairEmission(EXAMPLE_BLUEPRINT_ANSWER.world).document as { sim: unknown }),
  geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry,
  objects: [
    {
      stableId: 'hillsideTerrace',
      label: 'the hillside terrace',
      synonyms: ['the terrace', 'the slope'],
      role: 'terrain',
      source: { kind: 'geom', node: 0 },
      targetBounds: { min: [-13, -1, -9], max: [13, 1, 9] },
      importance: 2,
    },
    {
      stableId: 'drystoneWall',
      label: 'the drystone wall',
      synonyms: ['the wall'],
      role: 'architecture',
      source: { kind: 'geom', node: 2 },
      targetBounds: { min: [-10.5, 0, -5.6], max: [9.5, 1.4, -4.4] },
      importance: 2,
    },
    {
      stableId: 'tallHive',
      label: 'the tallest hive',
      synonyms: ['the hive'],
      role: 'hero',
      source: { kind: 'shape', shapeId: 'tallHiveShape' },
      targetBounds: { min: [-0.9, 0.6, 1.1], max: [0.9, 2.4, 2.9] },
      importance: 3,
    },
    {
      stableId: 'smokerBox',
      label: "the smoker's box",
      synonyms: ['the box'],
      role: 'prop',
      source: { kind: 'geom', node: 5 },
      targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] },
      importance: 1,
    },
  ],
  shapes: EXAMPLE_BLUEPRINT_ANSWER.shapes,
});

/**
 * Obálka kola kolem hotového blueprintu.
 *
 * `verdict`, `adjustments` a `repairs` jsou přetypované prázdno — jsou to stopy
 * o tom, jak blueprint vznikl, a `buildProxyWorld()` je nečte. `value` naopak
 * prošlo schématem, protože to je dokument, ze kterého se svět staví.
 */
export const DEMO_OUTCOME: BlueprintOutcome = {
  kind: 'compiled',
  rounds: [{ attempt: 1, fault: null, ms: 0 }],
  result: {
    ok: true,
    stage: 'worldstream-blueprint',
    value: DEMO_BLUEPRINT,
    verdict: undefined,
    adjustments: [],
    repairs: [],
  } as unknown as CompiledBlueprint,
};

/** Kam se kamera dívá. Kompozice je 26 polí široká a nízká, takže shora zboku. */
export const DEMO_CAMERA = { position: [17, 12, 21] as const, fov: 42 };

/**
 * Hrdinský tvar, který se dá materializovat. Ukázka má právě jeden a je to
 * záměr: `T20` soudí **přechod**, ne frontu.
 */
export const DEMO_HERO = DEMO_BLUEPRINT.objects.find((object) => object.source.kind === 'shape')!;

/** Program hrdiny. Ukázka ho má právě jeden, takže se hledá jednou a nahoře. */
export const DEMO_HERO_PROGRAM = DEMO_BLUEPRINT.shapes.find(
  (candidate) => DEMO_HERO.source.kind === 'shape' && candidate.shapeId === DEMO_HERO.source.shapeId,
)!;
