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
import { useCallback, useEffect, useRef, useState } from 'react';

import { sealSimHash } from '@/ir/worlddoc';
import { UI_TOKENS } from '@/kit';
import { repairEmission } from '@/model/repair';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import type { BlueprintOutcome, CompiledBlueprint } from '@/model/worldstream-repair';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import { MESH_DETAIL } from '@/shape/types';
import { shapeContentHash } from '@/worldstream/cache';
import type { DetailLevel } from '@/worldstream/mesh-gate';
import { buildProxyWorld, type ProxyWorld } from '@/worldstream/proxy';
import { blueprintSchema, type WorldstreamBlueprint } from '@/worldstream/schema';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '../../../components/viewer/WorldstreamLighting';
import WorldstreamStage, {
  type DetailUpgrade,
} from '../../../components/viewer/WorldstreamStage';

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

/**
 * Hrdinský tvar, který se dá materializovat. Ukázka má právě jeden a je to
 * záměr: `T20` soudí **přechod**, ne frontu.
 */
const HERO = DEMO_BLUEPRINT.objects.find((object) => object.source.kind === 'shape')!;

/** Program hrdiny. Ukázka ho má právě jeden, takže se hledá jednou a nahoře. */
const HERO_PROGRAM = DEMO_BLUEPRINT.shapes.find(
  (candidate) => HERO.source.kind === 'shape' && candidate.shapeId === HERO.source.shapeId,
)!;

/**
 * Dva snímky.
 *
 * Používá to jediné tlačítko — závod dvou výsledků (`T21`). Kandidát musí
 * stihnout obsadit slot dřív, než dorazí druhý, jinak by druhý nevytlačil nic
 * a test by měřil pořadí `setState`, ne chování scény. Dva snímky jsou zhruba
 * 32 ms proti 700 ms odhalení, takže okno je široké o řád.
 *
 * ⚠ `requestAnimationFrame` je tu legitimní: `CLAUDE.md` ho zakazuje **na
 * replay cestě**, a tahle stránka žádnou simulaci neběží.
 */
function twoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export default function WorldstreamDevPage() {
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<DetailUpgrade | null>(null);
  const mesher = useRef<MeshClient | null>(null);

  useEffect(() => {
    const client = createMeshClient();
    mesher.current = client;
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
      mesher.current = null;
      client.dispose();
    };
  }, []);

  /**
   * Objedná hrdinu na dané příčce. Nic neposílá na scénu — to dělá volající.
   *
   * **Spouští to tlačítko, ne časovač**, a je to vlastnost harnessu, ne
   * provizorium: přechod trvá necelou vteřinu a test i člověk potřebují vědět,
   * kdy začal. Automatické doběhnutí by se dalo pozorovat jedině závodem
   * s vlastním pollingem, a taková sada je nespolehlivá z principu.
   */
  const order = useCallback(async (level: DetailLevel): Promise<DetailUpgrade | null> => {
    const client = mesher.current;
    if (client === null) return null;

    const resolution = MESH_DETAIL[level].resolution;
    const mesh = await client.mesh({
      program: HERO_PROGRAM,
      sessionSeed: DEMO_BLUEPRINT.sessionSeed,
      resolution,
      bounds: HERO_PROGRAM.targetBounds,
    });
    return {
      stableId: HERO.stableId,
      contentHash: shapeContentHash(HERO_PROGRAM, resolution),
      level,
      mesh,
    };
  }, []);

  const report = useCallback((error: unknown) => {
    setFailure(error instanceof Error ? error.message : String(error));
  }, []);

  const materialize = useCallback(async () => {
    try {
      const next = await order('high');
      if (next !== null) setUpgrade(next);
    } catch (error: unknown) {
      report(error);
    }
  }, [order, report]);

  /**
   * Tentýž mesh, který se hlásí kvádrem přes dva sloty (`T21`).
   *
   * Vrcholy zůstávají platné a normály sedí — mění se **jedno** číslo, které
   * brána soudí. Bez toho by se testovala odolnost proti rozbitému poli, což
   * je jiná vada s jinou opravou; tahle cesta je blob, který přetekl svůj slot,
   * a to je nejčastější odmítnutí, jaké meshing vyrábí.
   */
  const overrun = useCallback(async () => {
    try {
      const next = await order('high');
      if (next === null) return;
      const { min, max } = next.mesh.bounds;
      setUpgrade({
        ...next,
        mesh: {
          ...next.mesh,
          bounds: {
            min: [min[0] * 2, min[1] * 2, min[2] * 2],
            max: [max[0] * 2, max[1] * 2, max[2] * 2],
          },
        },
      });
    } catch (error: unknown) {
      report(error);
    }
  }, [order, report]);

  /**
   * Dva výsledky na tentýž slot, druhý doprostřed odhalení prvního (`T21`).
   *
   * Oba se objednají **předem**. Kdyby se druhý objednával až po tom, co se
   * první začne odhalovat, závodil by meshing s délkou odhalení a sada by
   * červenala podle rychlosti stroje.
   */
  const race = useCallback(async () => {
    try {
      const [loser, winner] = await Promise.all([order('rough'), order('high')]);
      if (loser === null || winner === null) return;
      setUpgrade(loser);
      await twoFrames();
      setUpgrade(winner);
    } catch (error: unknown) {
      report(error);
    }
  }, [order, report]);

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
        {world !== null && <WorldstreamStage world={world} upgrade={upgrade} />}
      </Canvas>
      <div style={{ position: 'absolute', right: 12, bottom: 10, display: 'flex', gap: 8 }}>
        {(
          [
            ['materialize', 'materialize the hero', materialize],
            ['materialize-overrun', 'send a mesh that overruns the slot', overrun],
            ['materialize-race', 'race two results', race],
          ] as const
        ).map(([id, label, run]) => (
          <button
            key={id}
            type="button"
            data-testid={id}
            onClick={() => void run()}
            disabled={world === null}
            style={{
              padding: '6px 12px',
              background: id === 'materialize' ? UI_TOKENS.accent : UI_TOKENS.background,
              color: id === 'materialize' ? UI_TOKENS.background : UI_TOKENS.text,
              border: `1px solid ${UI_TOKENS.accent}`,
              borderRadius: 4,
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>
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
