'use client';

/**
 * Cílový snímek — **ručně napsaná scéna, na kterou musí produkt dosáhnout**.
 *
 * Je to brána K0 z plánu P13 a nejlevnější rozhodnutí celého projektu: dokud
 * není tenhle obraz dost dobrý, nemá smysl kolem něj stavět šest týdnů
 * infrastruktury. Odpovídá na jedinou otázku — *stojí ten svět za to, aby ho
 * někdo navštívil?* — a odpovídá na ni dřív, než se do něj pustí model.
 *
 * ## Co tady schválně NENÍ
 *
 * Model, API, `GeomProgram`, `ShapeProgram`, semínko z věty. **Nic.** Kdyby
 * snímek vznikal generovanou cestou, měřil by se generátor, ne cíl — a odpověď
 * „vypadá to špatně" by pak nešlo přiřadit k příčině. Tohle je referenční obraz
 * napsaný rukou; vlny 1 a 2 se k němu mají dopracovat.
 *
 * ## Co je na scéně a proč zrovna to
 *
 * Vlajkový prompt z design booku §4: *„A cathedral growing inside the skeleton
 * of a dead leviathan. Three singing organs hold its ribs open."* Je vybraný tak,
 * aby najednou vyžadoval neobvyklou kompozici, organickou hrdinskou geometrii a
 * vztah mezi objekty — tedy přesně to, co dnešní kulisa z 31 pevných variant
 * neumí. Cílový snímek tu větu **ukazuje**, aby bylo o čem rozhodovat.
 *
 * Scéna má tři výtvarné vrstvy, každou z jiného materiálu:
 *  - **žebra a páteř** z nepálené hlíny (`ClayMaterial`) — hrubá hmota, kterou
 *    design book §15.4 přiznává jako materiál, ne jako placeholder;
 *  - **katedrála** z čediče — hotová, chladná, geometricky pravidelná;
 *  - **tři varhany** jantarové a emisivní — jediný zdroj tepla v obraze.
 *
 * ## Varhany nesvítí jako světla
 *
 * `VIEWER_BUDGETS.maxLights` je 4 a rig je vyčerpal. Tři jantarové zdroje by
 * strop rozbily, takže záře je **emisivní materiál**: vypadá stejně, stojí nula
 * a rozpočet drží. Rozhodnutí, ne kompromis — bodové světlo by tady stejně
 * nemělo co osvítit, protože varhany stojí uvnitř klenby.
 *
 * ## Náhodnost je deterministická
 *
 * Rozsyp kamení jde z `pure-rand`, ne z `Math.random()` (`CLAUDE.md`). Snímek se
 * tak pokaždé složí stejně a `docs/target-frame.png` platí i po přebuildění.
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
  BoxGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';

import { UI_TOKENS } from '@/kit';

import { clayMaterial } from './ClayMaterial';
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

/** Kolik ramen kostry. Liché číslo, aby jedno žebro stálo přesně uprostřed. */
const RIB_COUNT = 21;

/**
 * Kde je klenba na straně ke kameře prolomená.
 *
 * **Sedmapadesát celých žeber je plot, ne klenba.** V první verzi zakryla
 * katedrálu tak dokonale, že z věty *„katedrála roste uvnitř kostry"* zbyla na
 * snímku jen kostra — a kdo prompt nezná, viděl trup lodi. Bližší strana je
 * proto v prostřední třetině vylomená a tou dírou je stavba vidět celá.
 *
 * Není to úklid kompozice, je to obsah: mezi vylomená žebra se opřely varhany.
 * Věta *„three singing organs hold its ribs open"* tím dostane obraz místo
 * popisku — okraje díry drží tři svítící válce a nic jiného.
 */
const RIB_GAP = { from: 7, to: 13 } as const;

/** Kolik obratlů. Hustěji než žebra, takže páteř čte jako souvislý oblouk. */
const VERTEBRA_COUNT = 41;

/** Sloupy katedrály uvnitř klenby. */
const COLUMN_COUNT = 16;

/** Kamení rozesypané po hladině. Semínko níž je jediný zdroj jeho polohy. */
const DEBRIS_COUNT = 26;

/** Semínko rozsypu. Pevné — cílový snímek se musí složit pokaždé stejně. */
const DEBRIS_SEED = 0x5eed_1337;

/** Poloviční délka kostry ve světových jednotkách. */
const SPAN = 25;

/** Výška páteře nad hladinou v místě `t` ∈ ⟨0,1⟩. Nejvýš uprostřed, klesá k ocasu. */
function spineHeight(t: number): number {
  const centred = t * 2 - 1;
  return 13.4 - 6.2 * centred * centred;
}

/** Jak široko je kostra v místě `t`. Nula na koncích, jedna uprostřed. */
function ribSpan(t: number): number {
  const centred = t * 2 - 1;
  return Math.sqrt(Math.max(0, 1 - centred * centred));
}

/**
 * Křivka jednoho žebra — od páteře ven a dolů k hladině.
 *
 * Catmull-Rom, ne oblouk kružnice: žebro se má nejdřív odklonit skoro vodorovně
 * a teprve pak spadnout dolů, což kružnice neumí. Čtyři kontrolní body jsou
 * minimum, kterým se ten tvar dá napsat.
 */
function ribCurve(t: number, side: 1 | -1): CatmullRomCurve3 {
  const x = (t * 2 - 1) * SPAN;
  const top = spineHeight(t);
  const width = 0.35 + 0.65 * ribSpan(t);
  const reach = 11.4 * width;

  return new CatmullRomCurve3([
    new Vector3(x, top, 0),
    new Vector3(x + side * 0.6, top - 0.4, side * reach * 0.42),
    new Vector3(x + side * 0.9, top - 5.4 * width, side * reach * 0.94),
    new Vector3(x + side * 0.5, top - 9.6 * width, side * reach * 0.86),
    new Vector3(x, 0.5, side * reach * 0.58),
  ]);
}

/**
 * Kostra leviatana — páteř, žebra a klouby, všechno z hlíny.
 *
 * Žebra mají **každé vlastní geometrii**, protože každé má jinou křivku; sdílet
 * se dá jen materiál. Obratle a klouby naopak instancují jeden tvar, takže
 * z 69 kusů jsou dvě kreslicí volání místo devětašedesáti.
 */
function Leviathan() {
  const material = useMemo(() => clayMaterial(), []);
  const jointMaterial = useMemo(() => clayMaterial({ color: '#b89a7a', roughness: 0.7 }), []);

  const ribs = useMemo(
    () =>
      Array.from({ length: RIB_COUNT * 2 }, (_, at) => {
        const index = Math.floor(at / 2);
        const side: 1 | -1 = at % 2 === 0 ? 1 : -1;
        return { index, side };
      })
        // Bližší strana chybí tam, kde je klenba vylomená. Filtruje se tady, ne
        // až v JSX: nevzniklá geometrie nestojí ani trojúhelníky, ani úklid.
        .filter(
          ({ index, side }) => !(side === 1 && index >= RIB_GAP.from && index <= RIB_GAP.to),
        )
        .map(({ index, side }) => {
          const t = index / (RIB_COUNT - 1);
          const width = 0.35 + 0.65 * ribSpan(t);
          return {
            key: `${String(index)}-${String(side)}`,
            // Míň žeber znamená silnější žebra, jinak by z klenby zbyly dráty.
            geometry: new TubeGeometry(ribCurve(t, side), 34, 0.3 + 0.42 * width, 9, false),
          };
        }),
    [],
  );

  const vertebrae = useMemo(() => new BoxGeometry(0.92, 0.78, 1.5), []);
  const joints = useMemo(() => new SphereGeometry(0.52, 10, 8), []);

  const vertebraRef = useRef<InstancedMesh>(null);
  const jointRef = useRef<InstancedMesh>(null);

  useEffect(() => {
    const matrix = new Matrix4();
    const spin = new Quaternion();
    const scale = new Vector3(1, 1, 1);

    const vertebraMesh = vertebraRef.current;
    if (vertebraMesh !== null) {
      for (let at = 0; at < VERTEBRA_COUNT; at += 1) {
        const t = at / (VERTEBRA_COUNT - 1);
        // Obratel se naklání podle sklonu páteře, jinak by oblouk vypadal jako
        // schodiště z vodorovných kostek.
        const slope = Math.atan2(spineHeight(t + 0.01) - spineHeight(t - 0.01), 0.02 * SPAN * 2);
        spin.setFromAxisAngle(new Vector3(0, 0, 1), slope);
        scale.set(1, 1, 0.8 + 0.5 * ribSpan(t));
        matrix.compose(new Vector3((t * 2 - 1) * SPAN, spineHeight(t), 0), spin, scale);
        vertebraMesh.setMatrixAt(at, matrix);
      }
      vertebraMesh.instanceMatrix.needsUpdate = true;
    }

    const jointMesh = jointRef.current;
    if (jointMesh !== null) {
      spin.identity();
      for (let at = 0; at < RIB_COUNT; at += 1) {
        const t = at / (RIB_COUNT - 1);
        const size = 0.75 + 0.55 * ribSpan(t);
        scale.set(size, size, size);
        matrix.compose(new Vector3((t * 2 - 1) * SPAN, spineHeight(t), 0), spin, scale);
        jointMesh.setMatrixAt(at, matrix);
      }
      jointMesh.instanceMatrix.needsUpdate = true;
    }
  }, []);

  return (
    <group>
      {ribs.map((rib) => (
        <mesh key={rib.key} geometry={rib.geometry} material={material} castShadow receiveShadow />
      ))}
      <instancedMesh
        ref={vertebraRef}
        args={[vertebrae, material, VERTEBRA_COUNT]}
        castShadow
        receiveShadow
      />
      <instancedMesh
        ref={jointRef}
        args={[joints, jointMaterial, RIB_COUNT]}
        castShadow
        receiveShadow
      />
    </group>
  );
}

/**
 * Katedrála uvnitř klenby — plošina, sloupy, oblouky a věž.
 *
 * Čedič proti hlíně: chladný, pravidelný, hotový. Ten kontrast je celá pointa
 * kompozice — **stavba roste uvnitř něčeho, co ji nepostavilo**.
 */
function Cathedral() {
  // **Čistý `basalt` je od pozadí vzdálený osm bodů jasu**, takže stavba uvnitř
  // klenby zmizela do černa a z kontrastu „hlína proti kameni" zbyla jen hlína.
  // Odstín zůstává čedičový, jen se posune k perleti — hue se nemění, mění se
  // jas. Míchá se z tokenů palety, ne z ručně napsaného hexu, aby stavba
  // sledovala paletu i po jejím přeladění.
  const stone = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color(UI_TOKENS.basalt).lerp(new Color(UI_TOKENS.nacre), 0.5),
        roughness: 0.62,
        metalness: 0.05,
      }),
    [],
  );
  const trim = useMemo(
    () => new MeshStandardMaterial({ color: UI_TOKENS.nacre, roughness: 0.45, metalness: 0.1 }),
    [],
  );

  const column = useMemo(() => new CylinderGeometry(0.44, 0.58, 7.4, 12), []);
  const arch = useMemo(() => new TorusGeometry(2.5, 0.26, 8, 22, Math.PI), []);
  const columnRef = useRef<InstancedMesh>(null);
  const archRef = useRef<InstancedMesh>(null);

  useEffect(() => {
    const matrix = new Matrix4();
    const spin = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const axisY = new Vector3(0, 1, 0);

    const columnMesh = columnRef.current;
    if (columnMesh !== null) {
      for (let at = 0; at < COLUMN_COUNT; at += 1) {
        const row = at % 2 === 0 ? 1 : -1;
        const along = Math.floor(at / 2) / (COLUMN_COUNT / 2 - 1);
        spin.identity();
        matrix.compose(new Vector3((along * 2 - 1) * 13.5, 4.9, row * 4.2), spin, scale);
        columnMesh.setMatrixAt(at, matrix);
      }
      columnMesh.instanceMatrix.needsUpdate = true;
    }

    const archMesh = archRef.current;
    if (archMesh !== null) {
      for (let at = 0; at < COLUMN_COUNT / 2; at += 1) {
        const along = at / (COLUMN_COUNT / 2 - 1);
        // Oblouk stojí napříč lodí, tedy otočený kolem svislé osy.
        spin.setFromAxisAngle(axisY, Math.PI / 2);
        matrix.compose(new Vector3((along * 2 - 1) * 13.5, 8.6, 0), spin, scale);
        archMesh.setMatrixAt(at, matrix);
      }
      archMesh.instanceMatrix.needsUpdate = true;
    }
  }, []);

  return (
    <group>
      {/* Stupňovitá plošina. Tři kvádry, ne jeden — schod je to, čím stavba
          dosedne na vodu místo aby z ní trčela. */}
      <mesh position={[0, 0.55, 0]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[34, 1.1, 13]} />
      </mesh>
      <mesh position={[0, 1.35, 0]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[31, 0.6, 11]} />
      </mesh>
      <mesh position={[0, 1.9, 0]} material={trim} castShadow receiveShadow>
        <boxGeometry args={[29, 0.5, 9.6]} />
      </mesh>
      <instancedMesh ref={columnRef} args={[column, stone, COLUMN_COUNT]} castShadow receiveShadow />
      <instancedMesh
        ref={archRef}
        args={[arch, stone, COLUMN_COUNT / 2]}
        castShadow
        receiveShadow
      />
      {/* Věž uprostřed. Jediný svislý prvek, který prorazí klenbu žeber — bez něj
          je kompozice jen vodorovná a nemá kam vést oko. */}
      <mesh position={[0, 11.5, 0]} material={stone} castShadow receiveShadow>
        <cylinderGeometry args={[1.05, 1.75, 12.5, 10]} />
      </mesh>
      <mesh position={[0, 18.4, 0]} material={trim} castShadow receiveShadow>
        <cylinderGeometry args={[0, 1.2, 3.2, 10]} />
      </mesh>
    </group>
  );
}

/**
 * Tři zpívající varhany, které drží žebra otevřená.
 *
 * Jediné teplo v obraze a jediná věc, která se **hýbe** — puls je pomalý a
 * malý, protože v cílovém snímku má říct „logika běží", ne strhnout pozornost.
 * Design book §14: *logika běží dřív, než dorazí detail*.
 *
 * Materiál je emisivní, ne světlo — důvod je v hlavičce souboru.
 */
function Organs() {
  // Stojí na plošině katedrály (horní schod končí v 2,15) a sahají až k žebrům,
  // která jsou nad nimi v 11,7. Nižší válce z první verze se do klenby vůbec
  // nedotýkaly, takže „drží žebra otevřená" byla věta bez obrazu. Prostřední
  // stojí blíž ke kameře než věž, čímž se scéna rozvrství do hloubky.
  const positions = useMemo<readonly Vector3[]>(
    () => [new Vector3(-9.5, 6.2, 6.6), new Vector3(1.5, 6.2, 8.4), new Vector3(11, 6.2, 5.4)],
    [],
  );

  const shell = useMemo(
    () => new MeshStandardMaterial({ color: '#3c5a5f', roughness: 0.5, metalness: 0.25 }),
    [],
  );
  const core = useMemo(
    () =>
      new MeshStandardMaterial({
        color: UI_TOKENS.amber,
        emissive: new Color(UI_TOKENS.amber),
        // Nad ~0,8 přebije emise všechno stínování a z píšťaly je plochý
        // žlutý výstřižek. Půl je hranice, kde ještě svítí a už má objem.
        emissiveIntensity: 0.5,
        roughness: 0.3,
      }),
    [],
  );
  const ring = useMemo(
    () =>
      new MeshStandardMaterial({
        color: UI_TOKENS.verdigris,
        emissive: new Color(UI_TOKENS.verdigris),
        emissiveIntensity: 0.5,
        roughness: 0.35,
        metalness: 0.4,
      }),
    [],
  );

  const pulse = useRef<(InstancedMesh | null)[]>([]);

  useFrame((state) => {
    // Mimo hashovaný stav — je to obraz, ne simulace, takže nástěnný čas je tu
    // ta správná jednotka (`CLAUDE.md`, seznam toho, co smí zůstat venku).
    const time = state.clock.elapsedTime;
    for (let at = 0; at < pulse.current.length; at += 1) {
      const node = pulse.current[at];
      if (node === null || node === undefined) continue;
      // Tři varhany dýchají posunuté o třetinu periody, aby scéna nepulzovala
      // jako jeden blikající celek.
      const phase = time * 0.9 + (at * Math.PI * 2) / 3;
      const swell = 1 + 0.055 * Math.sin(phase);
      node.scale.set(swell, 1 + 0.02 * Math.sin(phase), swell);
    }
  });

  return (
    <group>
      {positions.map((at, index) => (
        <group key={`organ-${String(index)}`} position={at}>
          {/* Pata z kamene. Plášť přes celou výšku jantarové jádro zakryl a
              z „jediného tepla v obraze" zbyl tmavý sloup, takže kámen drží
              jen patu. */}
          <mesh position={[0, -3.6, 0]} material={shell} castShadow receiveShadow>
            <cylinderGeometry args={[0.62, 1.95, 2.2, 16]} />
          </mesh>
          {/* Tělo se rozšiřuje vzhůru a končí rozevřeným ústím.

              **Tvar je opravený záměrně, ne vyladěný.** Válec se zaoblenou
              hlavou z předchozí verze měl siluetu, kterou nikdo v porotě
              nepřehlédne a nikdo o ní nechce mluvit; kuželové ústí čte jako
              varhanní píšťala a je to tentýž objekt v obraze. */}
          <mesh
            ref={(node) => {
              pulse.current[index] = node as unknown as InstancedMesh | null;
            }}
            position={[0, 0.3, 0]}
            material={core}
          >
            <cylinderGeometry args={[1.12, 0.66, 7.4, 16]} />
          </mesh>
          {/* Rozevřené ústí. `openEnded`, aby píšťala byla dutá a ne zazátkovaná. */}
          <mesh position={[0, 4.7, 0]} material={core}>
            <cylinderGeometry args={[1.78, 1.12, 1.5, 16, 1, true]} />
          </mesh>
          {/* Obruče. Měď kolem jantaru je jediné místo, kde se v obraze potkají
              obě teplé barvy palety — a zároveň to, co drží žebra rozepřená. */}
          <mesh position={[0, 3.9, 0]} material={ring} castShadow>
            <torusGeometry args={[1.09, 0.15, 8, 20]} />
          </mesh>
          <mesh position={[0, 0.9, 0]} material={ring} castShadow>
            <torusGeometry args={[0.94, 0.13, 8, 20]} />
          </mesh>
          <mesh position={[0, -2.1, 0]} material={ring} castShadow>
            <torusGeometry args={[0.76, 0.12, 8, 20]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/**
 * Černá voda a kamení na ní.
 *
 * Voda není průhledná ani animovaná — je to **plocha, která odráží jen světla**.
 * Odlesk hlavního světla po hladině je jediné, co v dolní třetině obrazu drží
 * hloubku, a stojí dva trojúhelníky.
 *
 * Kamení jde z `pure-rand` se semínkem `DEBRIS_SEED`, ne z `Math.random()`.
 */
function BlackWater() {
  // Drsnost 0,16 při kovovosti 0,42 je chrom, ne voda: odlesk obrysového světla
  // se srazil do jednoho přepáleného pruhu přes celou dolní třetinu a přebil
  // kompozici. Rozmáznutý odlesk drží hloubku a nekřičí.
  const surface = useMemo(
    () => new MeshStandardMaterial({ color: '#040c13', roughness: 0.55, metalness: 0.2 }),
    [],
  );
  const rock = useMemo(() => clayMaterial({ color: '#6d6152', roughness: 0.9, flatShading: true }), []);
  const stone = useMemo(() => new IcosahedronGeometry(1, 0), []);
  const debrisRef = useRef<InstancedMesh>(null);

  useEffect(() => {
    const mesh = debrisRef.current;
    if (mesh === null) return;

    const source = xoroshiro128plus(DEBRIS_SEED);
    const between = (from: number, to: number): number => uniformInt(source, 0, 1000) / 1000 * (to - from) + from;

    const matrix = new Matrix4();
    const spin = new Quaternion();
    const axis = new Vector3();
    const scale = new Vector3();

    for (let at = 0; at < DEBRIS_COUNT; at += 1) {
      axis.set(between(-1, 1), between(-1, 1), between(-1, 1)).normalize();
      spin.setFromAxisAngle(axis, between(0, Math.PI * 2));
      const size = between(0.35, 1.15);
      scale.set(size, size * between(0.4, 0.8), size);
      matrix.compose(
        new Vector3(between(-SPAN - 6, SPAN + 6), between(-0.15, 0.35), between(-22, 22)),
        spin,
        scale,
      );
      mesh.setMatrixAt(at, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={surface} receiveShadow>
        <planeGeometry args={[260, 260]} />
      </mesh>
      <instancedMesh ref={debrisRef} args={[stone, rock, DEBRIS_COUNT]} castShadow receiveShadow />
    </group>
  );
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
const FRAME_EYE = [19, 16, 49] as const;
const FRAME_TARGET = [-1, 7.5, 0] as const;

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
      <BlackWater />
      <Leviathan />
      <Cathedral />
      <Organs />
      <Probe />
      <Cleanup />
    </Canvas>
  );
}
