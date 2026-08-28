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
 * a mít ho nebude, protože to nejsou objekty světa. Produkt je bude řídit
 * stejně jako tady — jako vrstvu vykreslení nad geometrií.
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
import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';

import { PALETTES, UI_TOKENS } from '@/kit';

import { clayMaterial } from './ClayMaterial';
import { haloMaterial, moteMaterial, shaftMaterial } from './GlowMaterial';
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

/**
 * Poloviční šířka pásma, ve kterém prach visí.
 *
 * Odvozená z kompozice, ne zvolená: scéna je v `x` od −15 (okraj útesu) do +15
 * a prach musí sahat za obě hrany obrazu, jinak by se na krajích objevil ostrý
 * konec mlhy.
 */
const MOTE_FIELD = 34;

/** Kolik světelných kuželů prochází vodou. */
const SHAFT_COUNT = 3;

/**
 * Sklon světelných sloupů od svislice, v radiánech.
 *
 * Není vymyšlený: hlavní světlo stojí na `[26, 34, 18]`, takže svírá se svislicí
 * `atan(sqrt(26² + 18²) / 34)` ≈ 43°. Sloupy jdou o něco strměji (32°), protože
 * při plném sklonu vyjdou z obrazu dřív, než dosáhnou na kostru — je to jediné
 * místo, kde se obraz upřednostnil před fyzikou, a proto to stojí tady.
 */
const SHAFT_TILT = 0.36;

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
 * Obloha při soumraku.
 *
 * **Bez ní má snímek půlku plochy černou** a scéna se čte jako model ve
 * vitríně, ne jako místo pod otevřeným nebem. Přesně to bylo na první verzi
 * nejvíc vidět: pozadí nebylo dálka, byla to prázdnota.
 *
 * Koule s `BackSide` a spádem ve třech tokenech: `pelagic` v zenitu,
 * ztmavený `verdigris` u obzoru a `amber` jako zapadající světlo nízko vpravo
 * za věží. Žádná mlha (`fog: false`) — obloha je nekonečno, mlha by ji obarvila
 * do jedné plochy a spád by zmizel.
 */
function Sky() {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new Color(UI_TOKENS.pelagic) },
          uHorizon: { value: new Color(UI_TOKENS.pelagic).lerp(new Color(UI_TOKENS.verdigris), 0.16) },
          uGlow: { value: new Color(UI_TOKENS.amber).multiplyScalar(0.55) },
        },
        vertexShader: `
          varying vec3 vDirection;
          void main() {
            vDirection = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uZenith;
          uniform vec3 uHorizon;
          uniform vec3 uGlow;
          varying vec3 vDirection;
          void main() {
            float height = clamp(vDirection.y * 1.5 + 0.12, 0.0, 1.0);
            vec3 sky = mix(uHorizon, uZenith, pow(height, 0.5));
            float sun = max(0.0, dot(vDirection, normalize(vec3(0.5, 0.05, -0.86))));
            sky += uGlow * pow(sun, 7.0) * (1.0 - height);
            gl_FragColor = vec4(sky, 1.0);
          }
        `,
      }),
    [],
  );

  return (
    <mesh material={material} renderOrder={-1}>
      <sphereGeometry args={[180, 32, 20]} />
    </mesh>
  );
}

/**
 * Hladina.
 *
 * **Není v programu geometrie a je to rozhodnutí, ne mezera** — viz hlavičku
 * `target-program.ts`. Kit kus pro vodu nemá; voda je vrstva vykreslení jako
 * mlha nebo záře.
 *
 * Nízká drsnost a trochu kovovosti stačí na to, aby po hladině přeběhl odlesk
 * hlavního světla — a odlesk je jediná věc, která plochu udělá mokrou.
 * Deska je 600 jednotek široká, takže mlha (`far = 120`) ji sama rozpustí do
 * barvy oblohy a obzor vznikne bez jediné další vrstvy.
 */
function Water() {
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color(UI_TOKENS.pelagic).lerp(new Color(UI_TOKENS.verdigris), 0.2),
        roughness: 0.42,
        metalness: 0.15,
      }),
    [],
  );
  const geometry = useMemo(() => new PlaneGeometry(600, 600), []);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, WATER_LEVEL, -60]}
      rotation={[-Math.PI / 2, 0, 0]}
    />
  );
}

/**
 * Světelné sloupy procházející vodou.
 *
 * **Tohle je ta jediná vrstva, která z modelu na stole udělá místo.** Bez ní
 * scéna nemá čím ukázat, že mezi kamerou a kostrou je voda — objekty prostě
 * stojí v černu. Sloup není objem, je to kužel s additivním shaderem
 * (`shaftMaterial`), jehož jas se řídí tím, kolik plochy je v daném pixelu
 * vidět skrz; vypadá to jako světlo v kalné vodě a stojí to jedno kreslicí
 * volání na sloup.
 *
 * Sklon i směr jdou z polohy hlavního světla, ne z oka — viz `SHAFT_TILT`.
 * Rozestupy jsou nepravidelné schválně: pravidelné sloupy čtou jako plot.
 */
function LightShafts() {
  // Naměřeno okem 27. 8.: při 0,26 vyšly sloupy jako bílé pruhy přes celou
  // levou třetinu a přebily kostru. Světlo v kalné vodě je závoj, ne reflektor.
  const material = useMemo(() => shaftMaterial(UI_TOKENS.nacre, 0.05), []);
  const warm = useMemo(() => shaftMaterial('#ffe4b5', 0.04), []);

  // Šířka u dna, šířka u zdroje, posun podél kostry, hloubka, síla.
  const shafts = useMemo(
    () =>
      [
        { at: -26, z: -14, top: 0.7, bottom: 3.4, height: 46, warm: false },
        { at: -15, z: 2, top: 0.5, bottom: 2.2, height: 40, warm: true },
        { at: -6, z: -16, top: 0.9, bottom: 4.6, height: 48, warm: false },
        { at: 2, z: 9, top: 0.4, bottom: 1.8, height: 36, warm: true },
        { at: 10, z: -11, top: 0.8, bottom: 3.8, height: 45, warm: false },
        { at: 21, z: 4, top: 0.5, bottom: 2.6, height: 41, warm: true },
        { at: 31, z: -13, top: 1.0, bottom: 4.8, height: 48, warm: false },
      ].slice(0, SHAFT_COUNT),
    [],
  );

  return (
    <group position={[0, 7, 0]} rotation={[0, 0.42, SHAFT_TILT]}>
      {shafts.map((shaft) => (
        <mesh
          key={`shaft-${String(shaft.at)}`}
          position={[shaft.at, shaft.height * 0.42, shaft.z]}
          material={shaft.warm ? warm : material}
        >
          <cylinderGeometry args={[shaft.top, shaft.bottom, shaft.height, 18, 1, true]} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Záře kolem svítících míst — ruční náhrada bloomu.
 *
 * Čtverec s radiálním spádem, otočený čelem ke kameře. **Billboard se počítá
 * každý snímek**, protože jinak by se záře při otočení scény zploštila do
 * čárky. Kopíruje se rovnou kvaternion kamery, což je totéž co `lookAt` na
 * kameru, jen bez trigonometrie.
 *
 * Bez záře čte emisivní materiál jako světlá barva, ne jako zdroj světla —
 * a rozdíl mezi „žlutý válec" a „ta věc svítí" je celý tenhle komponent.
 */
function Halo({
  position,
  size,
  color,
  intensity,
}: {
  readonly position: readonly [number, number, number];
  readonly size: number;
  readonly color: string;
  readonly intensity: number;
}) {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(() => haloMaterial(color, intensity), [color, intensity]);

  useFrame((state) => {
    if (mesh.current !== null) mesh.current.quaternion.copy(state.camera.quaternion);
  });

  return (
    <mesh ref={mesh} position={[...position]} material={material}>
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}

/**
 * Prach ve vodě.
 *
 * `Points` s vlastním shaderem: **sedm set zrnek v jednom kreslicím volání**.
 * Instancované čtverce by stály sedm set matic a stejně by se musely otáčet ke
 * kameře; bod je čelem ke kameře zadarmo.
 *
 * Zrnka se pomalu snášejí — pohyb je z `uTime`, tedy z nástěnného času, což
 * je tady ta správná jednotka: stránka nemá simulaci a je celá mimo hashovaný
 * stav (`CLAUDE.md`).
 */
function Motes() {
  const material = useMemo(() => moteMaterial(UI_TOKENS.nacre, 1.5), []);

  const geometry = useMemo(() => {
    const source = xoroshiro128plus(DEEP_SEED);
    const between = (from: number, to: number): number =>
      (uniformInt(source, 0, 10_000) / 10_000) * (to - from) + from;

    const position = new Float32Array(MOTE_COUNT * 3);
    const phase = new Float32Array(MOTE_COUNT);
    for (let at = 0; at < MOTE_COUNT; at += 1) {
      position[at * 3] = between(-MOTE_FIELD, MOTE_FIELD);
      // Hustěji dole, řidčeji nahoře: mlha nad hladinou sedá k vodě.
      position[at * 3 + 1] = between(0, 1) ** 1.6 * 22 - 2;
      position[at * 3 + 2] = between(-34, 26);
      phase[at] = between(0, Math.PI * 2);
    }

    const buffer = new BufferGeometry();
    buffer.setAttribute('position', new BufferAttribute(position, 3));
    buffer.setAttribute('aPhase', new BufferAttribute(phase, 1));
    return buffer;
  }, []);

  const points = useRef<Points>(null);
  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <points ref={points} geometry={geometry} material={material} />;
}

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
      <Sky />
      <Water />
      <Place />
      <LightShafts />
      {/* Záře kolem svítících míst. Lampa na věži je nejjasnější bod obrazu —
          a jediný, který nese větu „tam někdo je". */}
      <Halo position={[2.6, 12.6, -8.4]} size={9} color={UI_TOKENS.amber} intensity={0.9} />
      <Halo position={[2.6, 3.4, -6.6]} size={2.6} color={UI_TOKENS.amber} intensity={0.34} />
      <Halo position={[2.6, 5.9, -6.6]} size={2.6} color={UI_TOKENS.amber} intensity={0.34} />
      <Halo position={[-6.4, 2.64, -6.1]} size={2.4} color={UI_TOKENS.amber} intensity={0.32} />
      <Halo position={[-3.7, 2.64, -6.1]} size={2.4} color={UI_TOKENS.amber} intensity={0.32} />
      <Halo position={[-1, 2.64, -6.1]} size={2.4} color={UI_TOKENS.amber} intensity={0.32} />
      <Halo position={[0, 3.6, -4]} size={3} color={UI_TOKENS.amber} intensity={0.22} />
      <Motes />
      <Probe />
      <Cleanup />
    </Canvas>
  );
}
