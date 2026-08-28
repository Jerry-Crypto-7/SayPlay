'use client';

/**
 * Cílový snímek — **ručně napsaná scéna, na kterou musí produkt dosáhnout**.
 *
 * Je to brána K0 z plánu P13 a nejlevnější rozhodnutí celého projektu: dokud
 * není tenhle obraz dost dobrý, nemá smysl kolem něj stavět šest týdnů
 * infrastruktury. Odpovídá na jedinou otázku — *stojí ten svět za to, aby ho
 * někdo navštívil?* — a odpovídá na ni dřív, než se do něj pustí model.
 *
 * ## Druhé kolo: geometrii píše program, ne tenhle soubor
 *
 * První verze (27. 8. 2026) byla 1132 řádků ručního `three` — kostra velryby
 * z trubek natažených po křivce. **Brána K0 ji 28. 8. shodila** a hlavní důvod
 * nebyl výtvarný: z produktového jazyka nepoužívala ani jeden kus, takže se
 * ptala „umí autor namalovat obrázek?" místo „dosáhne produkt na tenhle svět?".
 * Celý rozbor je v hlavičce `target-program.ts`.
 *
 * Scéna je teď **jedna deklarace `GeomProgram`** — přesně ten dokument, který
 * od vlny 2 emituje model — a staví ji `buildProgramGroup`, tedy tatáž cesta,
 * jakou produkt staví kulisu. Ručně napsaná zůstává, jak žádá AC úlohy T2:
 * **žádný model, žádné API, žádné semínko z věty.**
 *
 * ## Dělící čára: geometrie je program, atmosféra ne
 *
 * V programu je všechno, co má tvar — útes, skála, most, brána, schody,
 * zástavba, věž, porost. **Mimo program zůstává světlo, mlha, prach a záře.**
 * Není to úhybný manévr: kit nemá kus pro světelný kužel ani pro zrnko prachu
 * a mít ho nebude, protože to nejsou objekty světa.
 *
 * Od P14 T1 ta druhá polovina bydlí v `Atmosphere.tsx` a produkt ji používá
 * **tutéž**. Do té doby uměla oblohu, vodu a prach jedině tahle stránka, takže
 * polovina toho, co dělá z modelu na stole místo, se porotci nikdy neukázala.
 * Tenhle soubor zůstal tím, čím byl — kompozicí: říká, jaké barvy, kolik
 * sloupů a jak vysoko je hladina, nikoli jak se obloha kreslí.
 *
 * ## Náhodnost je deterministická
 *
 * Rozsypy v programu i prach jdou z `pure-rand`, ne z `Math.random()`
 * (`CLAUDE.md`), a semínka jsou pevná. Snímek se tak pokaždé složí stejně
 * a `docs/target-frame.png` platí i po přebuildění.
 *
 * ## Měřidlo snímku
 *
 * `window.__target` vydá, co renderer doopravdy udělal, a časy snímků. Čas se
 * bere z `performance.now()`, což je na replay cestě zakázané — tahle stránka
 * ale žádnou simulaci nemá a je celá mimo hashovaný stav, takže je to ta správná
 * jednotka. Bez měřidla by se rozpočet snímku dopočítával ze zdrojáku, a to o
 * skutečném stínovém průchodu netvrdí nic.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color } from 'three';

import { PALETTES, UI_TOKENS } from '@/kit';

import { Halo, LightShafts, Motes, Sky, Water } from './Atmosphere';
import { clayMaterial } from './ClayMaterial';
import { buildProgramGroup } from './scenery';
import { TARGET_PROGRAM } from './target-program';
import { disposeSubtree } from './dispose';
import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from './WorldstreamLighting';

/** Co si o snímku může přečíst test. Užší než `RenderStats` vieweru — tahle stránka nemá svět. */
export interface TargetStats {
  readonly toneMapping: number;
  readonly toneMappingExposure: number;
  readonly shadowMapEnabled: boolean;
  readonly shadowMapType: number;
  /** Skutečný atribut kontextu, ne to, co si plátno vyžádalo. */
  readonly antialias: boolean;
  /** Kreslicí volání posledního snímku, včetně stínového průchodu. */
  readonly calls: number;
  readonly triangles: number;
  readonly lights: number;
  /** Co hlásí ovladač. Rozhoduje o tom, jestli se smí soudit snímková frekvence. */
  readonly renderer: string;
}

declare global {
  interface Window {
    __target?: {
      /** Kolik snímků plátno vykreslilo. */
      frames: () => number;
      /** Co renderer doopravdy dostal a co za poslední snímek udělal. */
      stats: () => TargetStats;
      /**
       * Délky posledních snímků v milisekundách, v pořadí, ve kterém nastaly.
       * Test si z nich spočítá medián sám — průměr by jeden zadrhlý snímek
       * rozmazal do celé série.
       */
      frameTimes: () => readonly number[];
    };
  }
}

/** Semínko vzdálených skal a prachu. Vlastní stream, ne sdílený s rozsypem. */
const DEEP_SEED = 0x0cea_11e5;

/** Kolik zrnek prachu visí ve vzduchu. Jedno kreslicí volání pro všechna. */
const MOTE_COUNT = 700;

/** Kolik světelných kuželů prochází vodou. */
const SHAFT_COUNT = 3;

/**
 * Scéna postavená **programem geometrie**.
 *
 * Jediné místo, kde v tomhle souboru vzniká tvar. Program je `TARGET_PROGRAM`,
 * stavitel je `buildProgramGroup` — týž, kterým produkt staví kulisu — a
 * paleta je `worldstream`, tedy sedm tokenů design booku §15.1 přeložených na
 * šest slotů kitu.
 *
 * **Stín se tady zapíná**, na rozdíl od kulisy. Kulisa leží za dosahem stínové
 * kamery a stínový průchod by ji kreslil podruhé zbytečně; tady je stín polovina
 * obrazu — bez něj věž na skále nestojí, ale plave.
 *
 * Materiál je jeden na celou scénu, protože barvu nese geometrie
 * (`vertexColors`). `dispose()` uklízí obojí, jinak by po odchodu ze stránky
 * zůstaly buffery viset v paměti ovladače.
 */
function Place() {
  const built = useMemo(() => {
    // Bílý základ, barvu nese geometrie. Emisní podíl jde na nulu — s bílou
    // by z podlahy jasu byla bílá záře přes celou scénu.
    const material = clayMaterial({
      color: '#ffffff',
      vertexColors: true,
      flatShading: true,
      emissiveShare: 0,
    });
    const group = buildProgramGroup(TARGET_PROGRAM, PALETTES.worldstream, material, {
      shadows: true,
      name: 'target',
    });
    return { group, material };
  }, []);

  useEffect(
    () => () => {
      built.group.dispose();
      built.material.dispose();
    },
    [built],
  );

  return <primitive object={built.group.object} />;
}

/** Výška hladiny. Program o ní ví — pilíře mostu končí právě tady. */
const WATER_LEVEL = -3.2;

/**
 * Barvy, které tenhle snímek předá atmosféře.
 *
 * Stojí tady, ne v `Atmosphere.tsx`, a je to celý smysl vyjmutí: paleta je
 * rozhodnutí **snímku**, ne vrstvy. Kdyby si atmosféra sáhla na `UI_TOKENS`
 * sama, dostal by od ní tuhle oblohu i každý vygenerovaný svět a produkt by
 * měl jedno počasí navždy.
 *
 * Spád je ve třech tokenech WORLDSTREAM: `pelagic` v zenitu, ztmavený
 * `verdigris` u obzoru a `amber` jako zapadající světlo nízko vpravo za věží.
 * Studený `verdigris` v zenitu nepatří — rozsvícené okno má být pozvání
 * dovnitř, ne signální světlo.
 */
const SKY = {
  zenith: new Color(UI_TOKENS.pelagic),
  horizon: new Color(UI_TOKENS.pelagic).lerp(new Color(UI_TOKENS.verdigris), 0.16),
  glow: new Color(UI_TOKENS.amber).multiplyScalar(0.55),
} as const;

/** Hladina: `pelagic` posunutý k patině mědi, aby po ní přeběhl odlesk. */
const WATER_COLOR = new Color(UI_TOKENS.pelagic).lerp(new Color(UI_TOKENS.verdigris), 0.2);

/** Teplý sloup světla. Není z palety — je to barva slunce nad hladinou. */
const SHAFT_WARM = '#ffe4b5';

/**
 * Měřidlo snímku.
 *
 * Priorita 0, tedy běží před kreslením a nepřebírá ho: první callback
 * s prioritou ≥ 1 přepne R3F do ručního režimu a plátno přestane kreslit samo.
 *
 * Publikuje `window.__target` a **drží čtvrt sekundy historie**, ne jeden údaj:
 * medián se z jednoho čísla spočítat nedá a průměr by jeden zadrhlý snímek
 * rozmazal do celé série.
 */
function Probe() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const frames = useRef(0);
  const times = useRef<number[]>([]);
  const last = useRef<number | null>(null);

  useFrame(() => {
    frames.current += 1;
    const now = performance.now();
    if (last.current !== null) {
      times.current.push(now - last.current);
      // Strop je pamětní, ne statistický: bez něj pole roste po celou návštěvu.
      if (times.current.length > 600) times.current.shift();
    }
    last.current = now;
  }, 0);

  useEffect(() => {
    const context = gl.getContext();
    const info = context.getExtension('WEBGL_debug_renderer_info');

    window.__target = {
      frames: () => frames.current,
      frameTimes: () => [...times.current],
      stats: () => {
        let lights = 0;
        scene.traverse((node) => {
          if ((node as { isLight?: boolean }).isLight === true) lights += 1;
        });
        return {
          toneMapping: gl.toneMapping,
          toneMappingExposure: gl.toneMappingExposure,
          shadowMapEnabled: gl.shadowMap.enabled,
          shadowMapType: gl.shadowMap.type,
          antialias: context.getContextAttributes()?.antialias === true,
          calls: gl.info.render.calls,
          triangles: gl.info.render.triangles,
          lights,
          renderer:
            info === null
              ? context.getParameter(context.RENDERER as number).toString()
              : context.getParameter(info.UNMASKED_RENDERER_WEBGL).toString(),
        };
      },
    };

    return () => {
      delete window.__target;
    };
  }, [gl, scene]);

  return null;
}

/**
 * Rámování.
 *
 * **Výchozí kamera R3F se dívá do počátku**, tedy na hladinu — a kostra stojí
 * nad ní. Obraz se tím vytlačil k horní hraně a ustřihl se mu ocas i věž. Cíl
 * míří do třetiny výšky kompozice, ne na zem, takže se do snímku vejde voda pod
 * kostrou i špice katedrály nad ní.
 *
 * Vzdálenost je spočítaná, ne odhadnutá: kostra je `2 × SPAN` dlouhá a při
 * vodorovném zorném úhlu, který z `FRAME_FOV` plyne pro 16:9, se do snímku
 * vejde i s rezervou po stranách. Čísla jsou tady, ne v JSX, aby šla přečíst
 * spolu s tím, co ohraničují.
 */
const FRAME_FOV = 38;
const FRAME_EYE = [10, 8.6, 36] as const;
const FRAME_TARGET = [-1, 3.6, -6] as const;

function Framing() {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.position.set(...FRAME_EYE);
    camera.lookAt(...FRAME_TARGET);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

/**
 * Úklid po odchodu ze stránky.
 *
 * Ručně psaná scéna drží vlastní geometrie a materiály, které nikdo jiný
 * nesdílí — bez `dispose()` by po přechodu na jinou stránku zůstaly v paměti
 * ovladače. `disposeSubtree` je táž cesta, jakou uklízí viewer.
 */
function Cleanup() {
  const scene = useThree((state) => state.scene);
  useEffect(() => () => void disposeSubtree(scene), [scene]);
  return null;
}

export default function TargetFrame() {
  return (
    <Canvas
      data-testid="target-canvas"
      shadows={WORLDSTREAM_SHADOWS}
      gl={WORLDSTREAM_GL}
      // Pohled zboku a mírně shora: kostra se tím otevře do hloubky místo aby
      // stála jako plochý oblouk proti kameře. Cíl pohledu nastavuje `Framing`.
      camera={{ position: [...FRAME_EYE], fov: FRAME_FOV, near: 0.5, far: 400 }}
      style={{ background: UI_TOKENS.pelagic }}
    >
      <Framing />
      <WorldstreamLighting />
      {/* Neprůhledné vrstvy odzadu dopředu, additivní až nakonec: záře a prach
          mají `depthWrite: false`, takže by jinak zmizely za tím, co se
          nakreslí po nich. */}
      <Sky
        zenith={SKY.zenith}
        horizon={SKY.horizon}
        glow={SKY.glow}
      />
      <Water color={WATER_COLOR} level={WATER_LEVEL} />
      <Place />
      <LightShafts color={UI_TOKENS.nacre} warmColor={SHAFT_WARM} count={SHAFT_COUNT} />
      {/* Záře kolem svítících míst. Lampa na věži je nejjasnější bod obrazu —
          a jediný, který nese větu „tam někdo je". */}
      <Halo position={[2.6, 12.6, -8.4]} size={9} color={UI_TOKENS.amber} intensity={0.9} />
      <Halo position={[2.6, 3.4, -6.6]} size={2.6} color={UI_TOKENS.amber} intensity={0.34} />
      <Halo position={[2.6, 5.9, -6.6]} size={2.6} color={UI_TOKENS.amber} intensity={0.34} />
      <Halo position={[-6.4, 2.64, -6.1]} size={2.4} color={UI_TOKENS.amber} intensity={0.32} />
      <Halo position={[-3.7, 2.64, -6.1]} size={2.4} color={UI_TOKENS.amber} intensity={0.32} />
      <Halo position={[-1, 2.64, -6.1]} size={2.4} color={UI_TOKENS.amber} intensity={0.32} />
      <Halo position={[0, 3.6, -4]} size={3} color={UI_TOKENS.amber} intensity={0.22} />
      <Motes color={UI_TOKENS.nacre} count={MOTE_COUNT} seed={DEEP_SEED} />
      <Probe />
      <Cleanup />
    </Canvas>
  );
}
