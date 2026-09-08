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

import { UI_TOKENS } from '@/kit';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import { MESH_DETAIL } from '@/shape/types';
import { shapeContentHash } from '@/worldstream/cache';
import type { DetailLevel } from '@/worldstream/mesh-gate';
import { buildProxyWorld, slotResolutions, type ProxyWorld } from '@/worldstream/proxy';
import {
  budgetFor,
  detailLevelFor,
  pickQualityTier,
  type QualityTier,
} from '@/worldstream/quality';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '../../../components/viewer/WorldstreamLighting';
import WorldstreamStage, {
  type DetailUpgrade,
} from '../../../components/viewer/WorldstreamStage';

import {
  DEMO_BLUEPRINT,
  DEMO_CAMERA,
  DEMO_HERO,
  DEMO_HERO_PROGRAM,
  DEMO_OUTCOME,
} from '../demo-world';

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
/**
 * Rozpad přechodu z hrubé podoby na vysokou, **časovaný uvnitř stránky**
 * (P15 T26; `T39` skončila tím, že bez tohohle rozpadu je každé další
 * vysvětlení domněnka).
 *
 * Dvě půlky, protože každá stojí na něčem jiném a jenom jedna z nich má co
 * dělat s mřížkou: worker tvar spočítá, stránka ho pak protáhne bránou,
 * odhalením a commitem. Rozpočet §23 na „první hrdinský objekt" mířil na
 * součet a nikdo ho nikdy nerozdělil.
 */
export interface TransitionTiming {
  /** Objednávka u meshovacího workeru: od odeslání po hotový `MeshResult`. */
  readonly workerMs: number;
  /**
   * Od hotového meshe po commit odhalení: brána §12, stavba geometrie,
   * animace odhalení a zápis do registru.
   */
  readonly commitMs: number;
  /**
   * Kolik z `commitMs` je předepsaná animace odhalení, **pozorovaná na
   * scéně** — ne konstanta, protože `prefers-reduced-motion` ji zkracuje.
   * `null`, když odhalení proběhlo tak rychle, že ho ani jeden snímek
   * nezahlédl.
   */
  readonly revealMs: number | null;
}

declare global {
  interface Window {
    /** Poslední naměřený rozpad přechodu. `null`, dokud se nematerializovalo. */
    __worldstreamTransition?: () => TransitionTiming | null;
  }
}

/**
 * Počká na commit odhalení a cestou si všimne, jak dlouhé to odhalení bylo.
 *
 * Ptá se **sondy scény**, ne vlastního stavu: commit uzavírá `WorldstreamStage`
 * uvnitř svého `onDone`, takže stránka se o něm jinak nedozví. Čte se po
 * snímcích, protože o snímky přesně jde.
 */
function waitForCommit(from: number): Promise<number | null> {
  return new Promise((resolve) => {
    let reveal: number | null = null;
    const tick = (): void => {
      const stage = window.__worldstreamStage;
      reveal = stage?.reveal()?.durationMs ?? reveal;
      if ((stage?.commits() ?? 0) > from) resolve(reveal);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

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
  /** Poslední rozpad přechodu. Čte ho `window.__worldstreamTransition`. */
  const transition = useRef<TransitionTiming | null>(null);
  /**
   * Úroveň se volí **jednou, v efektu, těsně před stavbou** — ne při renderu.
   *
   * Dvakrát ze stejného důvodu: `pickTier()` sahá na `window` a na `<canvas>`,
   * které při prerenderu na serveru neexistují; a `buildProxyWorld()` úroveň
   * čte před fan-outem, přičemž rozlišení jde do `contentHash`, takže úroveň
   * měnící se mezi rendery by vyrobila dva světy se stejnými jmény slotů
   * (`quality.ts`, hlavička).
   */
  const tier = useRef<QualityTier>('full');

  useEffect(() => {
    window.__worldstreamTransition = () => transition.current;
    return () => {
      delete window.__worldstreamTransition;
    };
  }, []);

  useEffect(() => {
    const client = createMeshClient();
    mesher.current = client;
    let live = true;
    tier.current = pickQualityTier(window.location.search);

    buildProxyWorld(DEMO_OUTCOME, { mesh: (order) => client.mesh(order), quality: tier.current })
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

    // Rozlišení z `MESH_DETAIL` té příčky, ne z rozpočtu úrovně: příčku vybral
    // volající přes `detailLevelFor()`, a brána meshe soudí trojúhelníky podle
    // `MESH_DETAIL[level]`. Objednat jinou mřížku, než jakou soudí brána, je
    // přesně ta neshoda, kterou `detailLevelFor()` odstraňuje.
    const resolution = MESH_DETAIL[level].resolution;
    const mesh = await client.mesh({
      program: DEMO_HERO_PROGRAM,
      sessionSeed: DEMO_BLUEPRINT.sessionSeed,
      resolution,
      bounds: DEMO_HERO_PROGRAM.targetBounds,
    });
    return {
      stableId: DEMO_HERO.stableId,
      contentHash: shapeContentHash(DEMO_HERO_PROGRAM, resolution),
      level,
      mesh,
    };
  }, []);

  const report = useCallback((error: unknown) => {
    setFailure(error instanceof Error ? error.message : String(error));
  }, []);

  /**
   * Materializace, a **současně jediné místo, kde se přechod měří** (`T26`).
   *
   * Hodiny jsou tady, ne v testu, schválně: zvenku je vidět jen součet od
   * kliknutí po commit, a právě ten součet `T39` naměřila jako 2,5–5,3 s bez
   * vysvětlení. Rozdělit ho z Playwrightu nejde — hranici mezi workerem
   * a commitem uvnitř stránky žádná událost nenese.
   */
  const materialize = useCallback(async () => {
    try {
      const started = performance.now();
      const next = await order(detailLevelFor(tier.current));
      const meshed = performance.now();
      if (next === null) return;

      const before = window.__worldstreamStage?.commits() ?? 0;
      setUpgrade(next);
      const revealMs = await waitForCommit(before);
      transition.current = {
        workerMs: meshed - started,
        commitMs: performance.now() - meshed,
        revealMs,
      };
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
      const next = await order(detailLevelFor(tier.current));
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
      const [loser, winner] = await Promise.all([order('rough'), order(detailLevelFor(tier.current))]);
      if (loser === null || winner === null) return;
      setUpgrade(loser);
      await twoFrames();
      setUpgrade(winner);
    } catch (error: unknown) {
      report(error);
    }
  }, [order, report]);

  /**
   * Úroveň, kterou scéna zrovna kreslí.
   *
   * Bere se **ze světa, ne z `tier`**: dokud se svět staví, ref už úroveň zná,
   * ale nic z ní ještě nevzniklo, a plátno, které by mezitím přeskočilo na jiné
   * ratio, by si vyžádalo resize navíc. Odmítnutý svět nekreslí nic, takže na
   * něm nezáleží.
   */
  const shownQuality: QualityTier = world?.kind === 'built' ? world.quality : 'full';

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
        camera={{ position: [...DEMO_CAMERA.position], fov: DEMO_CAMERA.fov }}
        // **Rozsah, ne jedno číslo.** Rozpočet úrovně je horní mez: stroj,
        // který hlásí ratio 1, kreslí na 1 i na `full`, a teprve displej
        // s vyšší hustotou o ten stupínek doopravdy přijde.
        dpr={[1, budgetFor(shownQuality).pixelRatio]}
        data-testid="worldstream-stage-canvas"
      >
        <WorldstreamLighting quality={shownQuality} />
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
        // `pointerEvents: 'none'` je oprava, ne kosmetika: hláška roste s tím,
        // co o světě řekne, a jakmile přerostla polovinu šířky, přikryla
        // tlačítka harnessu a Playwright na ně přestal doklikat. Popisek nemá
        // co chytat myš.
        style={{
          position: 'absolute',
          left: 12,
          bottom: 10,
          margin: 0,
          opacity: 0.75,
          pointerEvents: 'none',
        }}
      >
        {failure !== null
          ? `rough world failed: ${failure}`
          : world === null
            ? 'building the rough world…'
            : world.kind === 'built'
              ? // **Mřížky z příček slotů, ne jedno číslo světa** (`T14r-worldgrid`).
                // `world.resolution` je objednávka; tvar, který se do rozpočtu
                // hrubé příčky nevešel, se přemeshoval o příčku níž, a věta,
                // která to zamlčí, se čte správně a je špatně.
                `${world.title} — ${world.slots.length} slots at ${slotResolutions(world).map((grid) => `${grid}³`).join(' / ') || 'no mesh'}, ${world.quality} quality, up to ${budgetFor(world.quality).heroes} authored ${budgetFor(world.quality).heroes === 1 ? 'shape' : 'shapes'}`
              : `declined: ${world.reason}`}
      </p>
    </main>
  );
}
