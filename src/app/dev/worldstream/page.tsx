'use client';

/**
 * `/dev/worldstream` — vývojová adresa, na které se hrubý svět poprvé kreslí
 * (P15 T19b).
 *
 * ## Proč vlastní adresa, a ne rovnou hlavní stránka
 *
 * Rozhodl uživatel 3. 9. 2026: most `ProxyWorld → RepresentationRegistry →
 * plátno` se nejdřív ověří sám o sobě a na hlavní cestu jde, teprve až je
 * prokázaný (`T21b`). Je to tentýž postup, jakým repo ověřuje `/gallery` a
 * `/dev/mesh-budget` — stránka bez zbytku produktu, na které se dá soudit
 * jediná věc.
 *
 * Kdyby se most stavěl rovnou do `page.tsx`, míchala by se do jednoho testu
 * relace, proud, vstupní pole i stará herní scéna, a červená by neřekla, která
 * z těch pěti věcí se rozbila.
 *
 * ## Blueprint je ruční, protože se tu nesoudí model
 *
 * Otázka téhle úlohy zní „dostane se hrubý svět na plátno celý a právě
 * jednou?". Odpověď nesmí záviset na tom, co model zrovna napsal — proto je
 * vstup pevný dokument protažený `blueprintSchema`. Že model takový dokument
 * umí napsat, měří `T14`, ne tahle stránka.
 *
 * Ukázková kompozice z promptu je tu ten nejlepší možný vstup: nese všechny
 * tři příčky, které hrubý svět umí obsadit — hrdinský tvar (`g3-reduced`),
 * dva různé řádky kompozice (`g2-rich`) a zbytek kusů jako kulisu.
 *
 * ## Proč tu není `notFound()` v produkci
 *
 * Táž volba jako u `/dev/mesh-budget`: e2e sada **je** produkční build, takže
 * schovaná stránka by se schovala i před vlastním testem. Cena je jedna adresa
 * navíc, na kterou z produktu nevede odkaz.
 */

import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';

import { sealSimHash } from '@/ir/worlddoc';
import { UI_TOKENS } from '@/kit';
import { repairEmission } from '@/model/repair';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import type { BlueprintOutcome, CompiledBlueprint } from '@/model/worldstream-repair';
import { createMeshClient } from '@/shape/mesh-client';
import { buildProxyWorld, type ProxyWorld } from '@/worldstream/proxy';
import { blueprintSchema, type WorldstreamBlueprint } from '@/worldstream/schema';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '../../../components/viewer/WorldstreamLighting';
import WorldstreamStage from '../../../components/viewer/WorldstreamStage';

/** Ruční blueprint. Čtyři objekty, tři cesty ke hmotě, jeden hrdinský tvar. */
const DEMO_BLUEPRINT: WorldstreamBlueprint = blueprintSchema.parse({
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
const DEMO_OUTCOME: BlueprintOutcome = {
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
const CAMERA = { position: [17, 12, 21] as const, fov: 42 };

export default function WorldstreamDevPage() {
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const client = createMeshClient();
    let live = true;

    buildProxyWorld(DEMO_OUTCOME, { mesh: (order) => client.mesh(order) })
      .then((built) => {
        if (live) setWorld(built);
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : String(error));
      });

    return () => {
      live = false;
      client.dispose();
    };
  }, []);

  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: UI_TOKENS.pelagic,
        color: UI_TOKENS.text,
        font: '13px/1.5 ui-monospace, monospace',
      }}
    >
      <Canvas
        gl={{ ...WORLDSTREAM_GL }}
        shadows={WORLDSTREAM_SHADOWS}
        camera={{ position: [...CAMERA.position], fov: CAMERA.fov }}
        data-testid="worldstream-stage-canvas"
      >
        <WorldstreamLighting />
        {world !== null && <WorldstreamStage world={world} />}
      </Canvas>
      <p
        data-testid="stage-status"
        style={{ position: 'absolute', left: 12, bottom: 10, margin: 0, opacity: 0.75 }}
      >
        {failure !== null
          ? `rough world failed: ${failure}`
          : world === null
            ? 'building the rough world…'
            : world.kind === 'built'
              ? `${world.title} — ${world.slots.length} slots at ${world.resolution}³`
              : `declined: ${world.reason}`}
      </p>
    </main>
  );
}
