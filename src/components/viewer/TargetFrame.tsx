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
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';

import { UI_TOKENS } from '@/kit';

import { clayMaterial } from './ClayMaterial';
import { haloMaterial, moteMaterial, shaftMaterial } from './GlowMaterial';
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

/** Sloupy ochozu vně zdí lodi. */
const COLUMN_COUNT = 16;

/** Opěráky. Sudý počet — na každé straně lodi jich stojí polovina. */
const BUTTRESS_COUNT = 14;

/** Kde v lodi svítí okna: `[x, z]`. Sedí na líci zdi, proto `|z| = 4,78`. */
const WINDOWS: readonly (readonly [number, number])[] = [
  [-12, 4.78],
  [-8, 4.78],
  [-4, 4.78],
  [0, 4.78],
  [4, 4.78],
  [-12, -4.78],
  [-8, -4.78],
  [-4, -4.78],
  [0, -4.78],
  [4, -4.78],
];

/** Kamení rozesypané po dně. Semínko níž je jediný zdroj jeho polohy. */
const DEBRIS_COUNT = 48;

/** Semínko rozsypu. Pevné — cílový snímek se musí složit pokaždé stejně. */
const DEBRIS_SEED = 0x5eed_1337;

/** Semínko vzdálených skal a prachu. Vlastní stream, ne sdílený s rozsypem. */
const DEEP_SEED = 0x0cea_11e5;

/** Kolik zrnek prachu visí ve vodě. Jedno kreslicí volání pro všechna. */
const MOTE_COUNT = 700;

/** Kolik světelných kuželů prochází vodou. */
const SHAFT_COUNT = 7;

/** Kolik skal stojí v mlze za kostrou. */
const SPIRE_COUNT = 11;

/** Balvany v popředí: `[x, z, velikost]`. Ručně rozmístěné, je jich pět. */
const FOREGROUND: readonly (readonly [number, number, number])[] = [
  [-24, 20, 4.6],
  [-17, 27, 3.0],
  [23, 18, 4.4],
  [28, 26, 3.4],
];

/**
 * Sklon světelných sloupů od svislice, v radiánech.
 *
 * Není vymyšlený: hlavní světlo stojí na `[26, 34, 18]`, takže svírá se svislicí
 * `atan(sqrt(26² + 18²) / 34)` ≈ 43°. Sloupy jdou o něco strměji (32°), protože
 * při plném sklonu vyjdou z obrazu dřív, než dosáhnou na kostru — je to jediné
 * místo, kde se obraz upřednostnil před fyzikou, a proto to stojí tady.
 */
const SHAFT_TILT = 0.36;

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
 * Katedrála uvnitř klenby — plošina, loď, sedlová střecha, opěráky a věž.
 *
 * Čedič proti hlíně: chladný, pravidelný, hotový. Ten kontrast je celá pointa
 * kompozice — **stavba roste uvnitř něčeho, co ji nepostavilo**.
 *
 * ## Proč tu přibyly zdi a střecha
 *
 * První verze byla sloupořadí: šestnáct sloupů, osm oblouků a věž. Na snímku
 * z toho byla **změť světlých tyček** a katedrálu v ní nikdo nenašel — z věty
 * *„a cathedral growing inside the skeleton"* tak zbyla jen kostra, protože ta
 * druhá půlka neměla siluetu. Silueta budovy je **loď se sedlovou střechou**;
 * dokud tam nebyla, nebylo co poznat. Sloupy zůstaly, ale stojí venku jako
 * ochoz, kde dělají rytmus místo aby zastupovaly celou stavbu.
 *
 * ## Okna nesou teplo, ne světlo
 *
 * `VIEWER_BUDGETS.maxLights` je 4 a rig je vyčerpal, takže okna jsou emisivní
 * plochy se září (`Halo`), ne zdroje. Vypadá to stejně a strop drží — táž
 * úvaha jako u varhan, a je to i důvod, proč okna sedí **na líci zdi**: kdyby
 * byla za ní, neměla by co prosvítit.
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
  // Střecha je o stupeň tmavší než zdi. Bez toho splyne se stěnou a sedlo,
  // kvůli kterému tu je, přestane být v siluetě vidět.
  const roofStone = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color(UI_TOKENS.basalt).lerp(new Color(UI_TOKENS.nacre), 0.3),
        roughness: 0.72,
        metalness: 0.04,
      }),
    [],
  );
  const trim = useMemo(
    () => new MeshStandardMaterial({ color: UI_TOKENS.nacre, roughness: 0.45, metalness: 0.1 }),
    [],
  );
  // Sklo je emisivní, ne prosvícené — pátý zdroj světla by rozbil
  // `VIEWER_BUDGETS.maxLights`, a okno stejně nemá co osvítit: stojí uvnitř lodi.
  const glass = useMemo(
    () =>
      new MeshStandardMaterial({
        color: UI_TOKENS.amber,
        emissive: new Color(UI_TOKENS.amber),
        emissiveIntensity: 0.62,
        roughness: 0.4,
      }),
    [],
  );

  const column = useMemo(() => new CylinderGeometry(0.4, 0.52, 6.4, 10), []);
  const buttress = useMemo(() => new BoxGeometry(0.7, 5.6, 0.55), []);
  const columnRef = useRef<InstancedMesh>(null);
  const buttressRef = useRef<InstancedMesh>(null);

  useEffect(() => {
    const matrix = new Matrix4();
    const spin = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const axisX = new Vector3(1, 0, 0);

    // Ochoz: dvě řady vně zdí lodi, aby mezi nimi a stěnou zůstala mezera,
    // kterou projde světlo z oken. Sloup nalepený na zeď by jen ztloustil zeď.
    const columnMesh = columnRef.current;
    if (columnMesh !== null) {
      for (let at = 0; at < COLUMN_COUNT; at += 1) {
        const row = at % 2 === 0 ? 1 : -1;
        const along = Math.floor(at / 2) / (COLUMN_COUNT / 2 - 1);
        spin.identity();
        matrix.compose(new Vector3((along * 2 - 1) * 14.2, 5.3, row * 6.3), spin, scale);
        columnMesh.setMatrixAt(at, matrix);
      }
      columnMesh.instanceMatrix.needsUpdate = true;
    }

    // Opěráky: šikmé vzpěry od zdi k ochozu. Jsou to ony, co ze zdi udělá
    // gotickou stavbu místo krabice — a stojí jeden box na kus.
    const buttressMesh = buttressRef.current;
    if (buttressMesh !== null) {
      for (let at = 0; at < BUTTRESS_COUNT; at += 1) {
        const row = at % 2 === 0 ? 1 : -1;
        const along = Math.floor(at / 2) / (BUTTRESS_COUNT / 2 - 1);
        spin.setFromAxisAngle(axisX, row * 0.42);
        matrix.compose(new Vector3((along * 2 - 1) * 13.6, 4.9, row * 5.6), spin, scale);
        buttressMesh.setMatrixAt(at, matrix);
      }
      buttressMesh.instanceMatrix.needsUpdate = true;
    }
  }, []);

  return (
    <group>
      {/* Stupňovitá plošina. Tři kvádry, ne jeden — schod je to, čím stavba
          dosedne na dno místo aby z něj trčela. */}
      <mesh position={[0, 0.55, 0]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[34, 1.1, 15]} />
      </mesh>
      <mesh position={[0, 1.35, 0]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[31, 0.6, 13]} />
      </mesh>
      <mesh position={[0, 1.9, 0]} material={trim} castShadow receiveShadow>
        <boxGeometry args={[29, 0.5, 11.4]} />
      </mesh>

      {/* Loď: dvě zdi a mezi nimi prostor. Tohle je ta silueta, která z tyček
          udělá budovu. */}
      <mesh position={[0, 5.9, 4.3]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[28, 7.4, 0.9]} />
      </mesh>
      <mesh position={[0, 5.9, -4.3]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[28, 7.4, 0.9]} />
      </mesh>
      {/* Apsida na vzdáleném konci. Půlválec, aby loď nekončila useknutě. */}
      <mesh position={[-14, 5.9, 0]} material={stone} castShadow receiveShadow>
        <cylinderGeometry args={[4.75, 4.75, 7.4, 14, 1, false, Math.PI / 2, Math.PI]} />
      </mesh>

      {/* Sedlová střecha: dvě desky opřené o sebe v hřebeni. */}
      <mesh position={[0, 11.1, 2.15]} rotation={[-0.72, 0, 0]} material={roofStone} castShadow>
        <boxGeometry args={[28.4, 0.5, 6.1]} />
      </mesh>
      <mesh position={[0, 11.1, -2.15]} rotation={[0.72, 0, 0]} material={roofStone} castShadow>
        <boxGeometry args={[28.4, 0.5, 6.1]} />
      </mesh>
      {/* Hřeben z perleti. Jediná vodorovná světlá linka v celé stavbě, takže
          oko po ní projde loď od apsidy k věži. */}
      <mesh position={[0, 12.6, 0]} material={trim} castShadow>
        <boxGeometry args={[28.6, 0.28, 0.4]} />
      </mesh>

      <instancedMesh ref={columnRef} args={[column, stone, COLUMN_COUNT]} castShadow receiveShadow />
      <instancedMesh
        ref={buttressRef}
        args={[buttress, stone, BUTTRESS_COUNT]}
        castShadow
        receiveShadow
      />

      {/* Okna lodi. Jediné místo, kde je zvenku vidět, že stavba je obydlená —
          a druhý zdroj tepla v obraze po varhanách. Sedí na líci zdi, ne za ní. */}
      {WINDOWS.map((window) => (
        <group key={`window-${String(window[0])}-${String(window[1])}`}>
          <mesh position={[window[0], 6.1, window[1]]} material={glass}>
            <boxGeometry args={[0.95, 3.8, 0.14]} />
          </mesh>
          {/* Lomený vrchol. Bez něj je okno obdélník a stavba čte jako sklad. */}
          <mesh
            position={[window[0], 8.0, window[1]]}
            rotation={[Math.PI / 2, 0, 0]}
            material={glass}
          >
            <cylinderGeometry args={[0.475, 0.475, 0.14, 10, 1, false, 0, Math.PI]} />
          </mesh>
          <Halo
            position={[window[0], 6.6, window[1] + Math.sign(window[1]) * 0.55]}
            size={3.4}
            color={UI_TOKENS.amber}
            intensity={0.24}
          />
        </group>
      ))}

      {/* Věž. Jediný svislý prvek, který prorazí klenbu žeber — bez něj je
          kompozice jen vodorovná a nemá kam vést oko. Stojí mimo střed, aby
          silueta nebyla souměrná. */}
      <mesh position={[9.5, 8.6, 0]} material={stone} castShadow receiveShadow>
        <boxGeometry args={[5.2, 13, 5.2]} />
      </mesh>
      <mesh position={[9.5, 15.4, 0]} material={trim} castShadow>
        <boxGeometry args={[5.8, 0.6, 5.8]} />
      </mesh>
      {/* Zvonice: prosvětlený otvor pod špicí. Nese oko na vrchol stavby. */}
      <mesh position={[9.5, 13.4, 2.66]} material={glass}>
        <boxGeometry args={[2.4, 3.2, 0.14]} />
      </mesh>
      <Halo position={[9.5, 13.4, 3.3]} size={7} color={UI_TOKENS.amber} intensity={0.3} />
      {/* Rozeta nad hlavním průčelím. Kruh je jediný v celé stavbě, takže se
          nedá přehlédnout — a je to znak, po kterém se katedrála pozná. */}
      <mesh position={[9.5, 10.2, 2.66]} rotation={[Math.PI / 2, 0, 0]} material={trim}>
        <torusGeometry args={[1.15, 0.16, 8, 20]} />
      </mesh>
      <mesh position={[9.5, 10.2, 2.62]} material={glass}>
        <cylinderGeometry args={[1.05, 1.05, 0.12, 16]} />
      </mesh>
      <Halo position={[9.5, 10.2, 3.2]} size={5.2} color={UI_TOKENS.amber} intensity={0.26} />
      <mesh position={[9.5, 18.6, 0]} material={roofStone} castShadow>
        <cylinderGeometry args={[0, 3.4, 6.4, 4]} />
      </mesh>
      <mesh position={[9.5, 22.4, 0]} material={trim} castShadow>
        <cylinderGeometry args={[0, 0.55, 1.6, 4]} />
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
          {/* Dvě záře, ne jedna: úzká drží jádro ostré, široká dělá dosvit ve
              vodě. Jedna střední by musela být obojí a vyšla by jako flek. */}
          <Halo position={[0, 4.4, 0]} size={7.2} color={UI_TOKENS.amber} intensity={0.5} />
          <Halo position={[0, 4.4, 0]} size={2.6} color="#fff0cf" intensity={0.85} />
          <Halo position={[0, 0.2, 0]} size={5.4} color={UI_TOKENS.amber} intensity={0.22} />
        </group>
      ))}
    </group>
  );
}

/**
 * Výška dna v daném místě.
 *
 * Součet tří sinusovek, ne šum z generátoru: je **deterministická bez semínka**,
 * takže dno vyjde stejně i kdyby se pořadí volání PRNG kdekoli jinde změnilo.
 * Amplitudy klesají a frekvence rostou, což dá dlouhou vlnu s drobnější kresbou
 * navrch — přesně to, po čem světlo pod ostrým úhlem klouže.
 */
function seabedHeight(x: number, z: number): number {
  return (
    2.1 * Math.sin(x * 0.052) * Math.cos(z * 0.047) +
    0.95 * Math.sin(x * 0.131 + 1.7) * Math.cos(z * 0.113 - 0.6) +
    0.38 * Math.sin(x * 0.287 - 0.4) * Math.cos(z * 0.311 + 2.1)
  );
}

/**
 * Černá voda a kamení na ní.
 *
 * **Dno není placka.** Rovina o dvou trojúhelnících neměla co nastavit světlu,
 * takže spodní třetina obrazu byla mrtvá černá plocha a scéna se četla jako
 * model na stole. Mřížka `96 × 96` s reliéfem z `seabedHeight` stojí 18 432
 * trojúhelníků a je to jediné, co dolní třetině dá kresbu.
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

  // Dno se skládá jednou a drží se; přepočítávat ho každý snímek by nic nezměnilo.
  const floor = useMemo(() => {
    const grid = new PlaneGeometry(320, 320, 96, 96);
    grid.rotateX(-Math.PI / 2);
    const position = grid.getAttribute('position');
    for (let at = 0; at < position.count; at += 1) {
      const x = position.getX(at);
      const z = position.getZ(at);
      position.setY(at, seabedHeight(x, z) - 0.2);
    }
    position.needsUpdate = true;
    grid.computeVertexNormals();
    return grid;
  }, []);
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
      const size = between(0.3, 1.9);
      scale.set(size, size * between(0.4, 0.8), size);
      const x = between(-SPAN - 8, SPAN + 8);
      const z = between(-26, 26);
      // Kámen sedí na dně, ne v rovině nuly — jinak by půlka visela ve vodě.
      matrix.compose(new Vector3(x, seabedHeight(x, z) - 0.2 + size * 0.25, z), spin, scale);
      mesh.setMatrixAt(at, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  return (
    <group>
      <mesh geometry={floor} material={surface} receiveShadow />
      <instancedMesh ref={debrisRef} args={[stone, rock, DEBRIS_COUNT]} castShadow receiveShadow />
    </group>
  );
}

/**
 * Balvany v popředí.
 *
 * **Rámují obraz a dávají mu měřítko.** Bez nich má snímek dva plány — kostru
 * a mlhu — a čte se jako exponát ve vitríně: nic není blíž než hlavní objekt,
 * takže není z čeho poznat, jak je ta kostra veliká. Balvan třicet jednotek od
 * kamery je ta třetí rovina; zároveň zaplní dolní rohy, které byly mrtvá černá
 * plocha.
 *
 * **Napoprvé stály na `z = 24..37` a v obraze nebyly vůbec.** Kamera je na
 * `y = 16` a dívá se mírně dolů, takže kámen ležící na dně patnáct jednotek
 * před ní padne pod spodní hranu záběru: svislý úhel k němu je při té
 * vzdálenosti větší než polovina zorného úhlu. Rám musí stát **dál** a být
 * větší, ne blíž — což je přesně naopak, než jak se popředí intuitivně staví.
 *
 * Jsou schválně **tmavé a bez detailu**: hlavní světlo je nad scénou a na
 * přivrácenou stranu skoro nedopadá. Kdyby byly čitelné, staly by se z rámu
 * další objekt, o který oko zakopne dřív než o katedrálu.
 */
function Foreground() {
  // **Ne `clayMaterial`.** Hlína má podlahu jasu (`emissiveShare`), aby se
  // odvrácená strana neztratila — jenže popředí se ztratit MÁ. S ní vyšly
  // balvany jako světlé desky a četly se jako zeď přes celý dolní roh.
  const rock = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color(UI_TOKENS.pelagic).lerp(new Color('#6d6152'), 0.28),
        roughness: 1,
        metalness: 0,
        flatShading: true,
      }),
    [],
  );
  const geometry = useMemo(() => new IcosahedronGeometry(1, 0), []);
  const boulders = useRef<InstancedMesh>(null);

  useEffect(() => {
    const mesh = boulders.current;
    if (mesh === null) return;

    const source = xoroshiro128plus(DEEP_SEED ^ 0x1d);
    const between = (from: number, to: number): number =>
      (uniformInt(source, 0, 10_000) / 10_000) * (to - from) + from;

    const matrix = new Matrix4();
    const spin = new Quaternion();
    const axis = new Vector3();
    const scale = new Vector3();

    for (let at = 0; at < FOREGROUND.length; at += 1) {
      const [x, z, size] = FOREGROUND[at];
      axis.set(between(-1, 1), between(-1, 1), between(-1, 1)).normalize();
      spin.setFromAxisAngle(axis, between(0, Math.PI * 2));
      scale.set(size, size * between(0.55, 0.85), size * between(0.8, 1.15));
      matrix.compose(new Vector3(x, seabedHeight(x, z) - 0.2 + size * 0.3, z), spin, scale);
      mesh.setMatrixAt(at, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  return <instancedMesh ref={boulders} args={[geometry, rock, FOREGROUND.length]} castShadow />;
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
  const material = useMemo(() => shaftMaterial(UI_TOKENS.nacre, 0.115), []);
  const warm = useMemo(() => shaftMaterial('#ffe4b5', 0.085), []);

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
    <group rotation={[0, 0.42, SHAFT_TILT]}>
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
      position[at * 3] = between(-SPAN - 18, SPAN + 18);
      // Hustěji dole, řidčeji nahoře: kal se drží u dna.
      position[at * 3 + 1] = between(0, 1) ** 1.6 * 26 + 0.4;
      position[at * 3 + 2] = between(-34, 30);
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
 * Skály v mlze za kostrou.
 *
 * **Dělají ze scény svět, ne exponát.** Dokud za kostrou nebylo nic, neměl
 * obraz čím říct, jak je velká — mlha končila v prázdnu a hloubka se dala jen
 * tušit. **Dvakrát stály moc daleko a dvakrát po nich v obraze
 * nezbylo nic.** Mlha má `far = 96` a **barvu pozadí**, takže cokoliv dál než
 * 96 jednotek od kamery není slabá silueta, ale doslova pozadí — táž barva.
 * Kamera stojí na `z = 49`, takže i skála na `z = −40` je od ní 90 jednotek
 * daleko. Pásmo je proto `z` od −34 do −6 a `far` mlhy se posunul na 120.
 * Píše se to sem proto, že ten výpočet je neintuitivní a jinak by se udělal
 * potřetí. Skály se navíc vyhýbají koridoru kostry (`|x| < 28`), aby jí
 * nestály za zády.
 */
function Spires() {
  const stone = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color(UI_TOKENS.basalt).lerp(new Color(UI_TOKENS.nacre), 0.16),
        roughness: 0.95,
        flatShading: true,
      }),
    [],
  );
  // Pět stěn místo sedmi: hrubší silueta, která v mlze čte jako skála, ne kužel.
  const geometry = useMemo(() => new CylinderGeometry(0.5, 5.2, 1, 5, 1), []);
  const spires = useRef<InstancedMesh>(null);

  useEffect(() => {
    const mesh = spires.current;
    if (mesh === null) return;

    const source = xoroshiro128plus(DEEP_SEED ^ 0x77);
    const between = (from: number, to: number): number =>
      (uniformInt(source, 0, 10_000) / 10_000) * (to - from) + from;

    const matrix = new Matrix4();
    const spin = new Quaternion();
    const axisY = new Vector3(0, 1, 0);
    const scale = new Vector3();

    for (let at = 0; at < SPIRE_COUNT; at += 1) {
      const height = between(18, 46);
      // Koridor kostry se přeskočí posunem, ne opakovaným losováním: druhý los
      // by posunul stream a rozsyp by se změnil při každé úpravě rozsahu.
      const raw = between(-64, 64);
      const x = raw + Math.sign(raw || 1) * 32;
      const z = between(-34, -6);
      // Náklon kolem vodorovné osy rozbije jehlan v pravidelný kužel; bez něj
      // stojí za kostrou řada souměrných špiček a čte se to jako kulisa.
      spin.setFromAxisAngle(axisY, between(0, Math.PI * 2));
      spin.multiply(
        new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0.4).normalize(), between(-0.18, 0.18)),
      );
      scale.set(between(0.6, 1.9), height, between(0.6, 1.9));
      matrix.compose(new Vector3(x, height * 0.5 + seabedHeight(x, z) - 0.6, z), spin, scale);
      mesh.setMatrixAt(at, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  return <instancedMesh ref={spires} args={[geometry, stone, SPIRE_COUNT]} />;
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
      {/* Neprůhledné vrstvy odzadu dopředu, additivní až nakonec: záře a prach
          mají `depthWrite: false`, takže by jinak zmizely za tím, co se
          nakreslí po nich. */}
      <Spires />
      <BlackWater />
      <Foreground />
      <Leviathan />
      <Cathedral />
      <Organs />
      <LightShafts />
      <Motes />
      <Probe />
      <Cleanup />
    </Canvas>
  );
}
