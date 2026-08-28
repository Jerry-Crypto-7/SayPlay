'use client';

/**
 * **Atmosféra** — obloha, voda, světelné sloupy, záře a prach.
 *
 * Vrstva vykreslení nad geometrií, ne kus v kitu. Kit díl pro oblohu ani pro
 * zrnko prachu nemá a mít nebude: nejsou to objekty světa, jsou to podmínky,
 * ve kterých svět stojí. Dělící čáru pojmenovává hlavička `target-program.ts`
 * a tenhle soubor je ta druhá strana.
 *
 * ## Proč to stojí zvlášť
 *
 * Do 28. 8. 2026 žilo všech pět komponent uvnitř `TargetFrame.tsx`, tedy
 * v ručně napsaném cílovém snímku. Produktový prohlížeč měl proti němu jen
 * plochou mlhu a jedno pozadí — polovinu toho, co dělá z modelu na stole
 * místo, uměla **jediná stránka**, na kterou se porotce nedostane. Vyjmutí
 * nemění, jak snímek vypadá (naměřeno: 10 754 trojúhelníků, 51 kreslicích
 * volání, 4 světla před i po); mění, kdo to smí použít.
 *
 * ## Barvy jsou parametr, ne konstanta
 *
 * Ani jeden `UI_TOKENS` uvnitř. Cílový snímek si předává paletu WORLDSTREAM,
 * produkt si předá tu, kterou má svět (`deriveLook`) — a kdyby si tenhle
 * soubor sáhl na tokeny sám, byl by z něj druhý cílový snímek a každý
 * vygenerovaný svět by dostal jeho oblohu.
 *
 * ## Nástěnný čas je tady v pořádku
 *
 * Prach se snáší podle `state.clock`, tedy podle nástěnných hodin. Atmosféra
 * stojí **mimo hashovaný stav** (`CLAUDE.md`), stejně jako částice, zvuk,
 * kamera a postprocessing — přetáčení času ji nepřepočítává a replay se o ni
 * neopírá.
 */

import { useFrame } from '@react-three/fiber';
import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { useEffect, useMemo, useRef } from 'react';
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  ShaderMaterial,
} from 'three';

import { haloMaterial, moteMaterial, shaftMaterial } from './GlowMaterial';

/**
 * Obloha při soumraku.
 *
 * **Bez ní má snímek půlku plochy černou** a scéna se čte jako model ve
 * vitríně, ne jako místo pod otevřeným nebem. Přesně to bylo na první verzi
 * cílového snímku nejvíc vidět: pozadí nebylo dálka, byla to prázdnota.
 *
 * Koule s `BackSide` a spádem ve třech barvách: zenit, obzor a zapadající
 * světlo nízko nad obzorem. Žádná mlha (`fog: false`) — obloha je nekonečno,
 * mlha by ji obarvila do jedné plochy a spád by zmizel.
 */
export function Sky({
  zenith,
  horizon,
  glow,
  radius = 180,
}: {
  readonly zenith: ColorRepresentation;
  readonly horizon: ColorRepresentation;
  readonly glow: ColorRepresentation;
  readonly radius?: number;
}) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new Color(zenith) },
          uHorizon: { value: new Color(horizon) },
          uGlow: { value: new Color(glow) },
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
    [zenith, horizon, glow],
  );

  useEffect(() => () => void material.dispose(), [material]);

  return (
    <mesh material={material} renderOrder={-1}>
      <sphereGeometry args={[radius, 32, 20]} />
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
 * hlavního světla — a odlesk je jediná věc, která plochu udělá mokrou. Deska
 * je široká natolik, aby ji mlha sama rozpustila do barvy oblohy a obzor
 * vznikl bez jediné další vrstvy.
 */
export function Water({
  color,
  level,
  depth = -60,
  size = 600,
}: {
  readonly color: ColorRepresentation;
  readonly level: number;
  readonly depth?: number;
  readonly size?: number;
}) {
  const material = useMemo(
    () => new MeshStandardMaterial({ color: new Color(color), roughness: 0.42, metalness: 0.15 }),
    [color],
  );
  const geometry = useMemo(() => new PlaneGeometry(size, size), [size]);

  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, level, depth]}
      rotation={[-Math.PI / 2, 0, 0]}
    />
  );
}

/**
 * Sklon světelných sloupů od svislice, v radiánech.
 *
 * Není vymyšlený: hlavní světlo cílového snímku stojí na `[26, 34, 18]`, takže
 * svírá se svislicí `atan(sqrt(26² + 18²) / 34)` ≈ 43°. Sloupy jdou o něco
 * strměji (32°), protože při plném sklonu vyjdou z obrazu dřív, než dosáhnou
 * na hlavní objekt — je to jediné místo, kde se obraz upřednostnil před
 * fyzikou, a proto to stojí tady.
 */
export const SHAFT_TILT = 0.36;

/**
 * Rozměry sedmi možných sloupů: poloha, šířka u zdroje a u dna, délka.
 *
 * Rozestupy jsou nepravidelné schválně — pravidelné sloupy čtou jako plot.
 * Bere se jich prvních `count`, takže scéna, která si jich vyžádá míň, dostane
 * **tytéž** sloupy jako dřív, ne jinak rozmístěné.
 */
const SHAFTS = [
  { at: -26, z: -14, top: 0.7, bottom: 3.4, height: 46, warm: false },
  { at: -15, z: 2, top: 0.5, bottom: 2.2, height: 40, warm: true },
  { at: -6, z: -16, top: 0.9, bottom: 4.6, height: 48, warm: false },
  { at: 2, z: 9, top: 0.4, bottom: 1.8, height: 36, warm: true },
  { at: 10, z: -11, top: 0.8, bottom: 3.8, height: 45, warm: false },
  { at: 21, z: 4, top: 0.5, bottom: 2.6, height: 41, warm: true },
  { at: 31, z: -13, top: 1.0, bottom: 4.8, height: 48, warm: false },
] as const;

/**
 * Světelné sloupy procházející vzduchem nebo vodou.
 *
 * **Tohle je ta jediná vrstva, která z modelu na stole udělá místo.** Bez ní
 * scéna nemá čím ukázat, že mezi kamerou a objektem něco je — objekty prostě
 * stojí v černu. Sloup není objem, je to kužel s additivním shaderem
 * (`shaftMaterial`), jehož jas se řídí tím, kolik plochy je v daném pixelu
 * vidět skrz; vypadá to jako světlo v kalné vodě a stojí to jedno kreslicí
 * volání na sloup.
 *
 * Naměřeno okem 27. 8.: při síle 0,26 vyšly sloupy jako bílé pruhy přes celou
 * levou třetinu a přebily hlavní objekt. Světlo v kalné vodě je závoj, ne
 * reflektor — proto je výchozí síla o řád níž.
 */
export function LightShafts({
  color,
  warmColor,
  count = 3,
  intensity = 0.05,
  warmIntensity = 0.04,
  tilt = SHAFT_TILT,
}: {
  readonly color: ColorRepresentation;
  readonly warmColor: ColorRepresentation;
  readonly count?: number;
  readonly intensity?: number;
  readonly warmIntensity?: number;
  readonly tilt?: number;
}) {
  const cold = useMemo(() => shaftMaterial(color, intensity), [color, intensity]);
  const warm = useMemo(() => shaftMaterial(warmColor, warmIntensity), [warmColor, warmIntensity]);
  const shafts = useMemo(() => SHAFTS.slice(0, count), [count]);

  useEffect(
    () => () => {
      cold.dispose();
      warm.dispose();
    },
    [cold, warm],
  );

  return (
    <group position={[0, 7, 0]} rotation={[0, 0.42, tilt]}>
      {shafts.map((shaft) => (
        <mesh
          key={`shaft-${String(shaft.at)}`}
          position={[shaft.at, shaft.height * 0.42, shaft.z]}
          material={shaft.warm ? warm : cold}
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
export function Halo({
  position,
  size,
  color,
  intensity,
}: {
  readonly position: readonly [number, number, number];
  readonly size: number;
  readonly color: ColorRepresentation;
  readonly intensity: number;
}) {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(() => haloMaterial(color, intensity), [color, intensity]);

  useEffect(() => () => void material.dispose(), [material]);

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
 * Poloviční šířka pásma, ve kterém prach visí.
 *
 * Odvozená z kompozice cílového snímku, ne zvolená: scéna je v `x` od −15
 * (okraj útesu) do +15 a prach musí sahat za obě hrany obrazu, jinak by se na
 * krajích objevil ostrý konec mlhy.
 */
export const MOTE_FIELD = 34;

/**
 * Prach ve vzduchu.
 *
 * `Points` s vlastním shaderem: **sedm set zrnek v jednom kreslicím volání**.
 * Instancované čtverce by stály sedm set matic a stejně by se musely otáčet ke
 * kameře; bod je čelem ke kameře zadarmo.
 *
 * Rozsyp jde z `pure-rand` se semínkem v parametru, nikdy z `Math.random()`
 * (`CLAUDE.md`), takže se pole prachu složí pokaždé stejně. Pohyb naopak jde
 * z nástěnného času — viz hlavičku souboru.
 */
export function Motes({
  color,
  count = 700,
  size = 1.5,
  field = MOTE_FIELD,
  seed,
}: {
  readonly color: ColorRepresentation;
  readonly count?: number;
  readonly size?: number;
  readonly field?: number;
  readonly seed: number;
}) {
  const material = useMemo(() => moteMaterial(color, size), [color, size]);

  const geometry = useMemo(() => {
    const source = xoroshiro128plus(seed);
    const between = (from: number, to: number): number =>
      (uniformInt(source, 0, 10_000) / 10_000) * (to - from) + from;

    const position = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    for (let at = 0; at < count; at += 1) {
      position[at * 3] = between(-field, field);
      // Hustěji dole, řidčeji nahoře: mlha nad hladinou sedá k vodě.
      position[at * 3 + 1] = between(0, 1) ** 1.6 * 22 - 2;
      position[at * 3 + 2] = between(-34, 26);
      phase[at] = between(0, Math.PI * 2);
    }

    const buffer = new BufferGeometry();
    buffer.setAttribute('position', new BufferAttribute(position, 3));
    buffer.setAttribute('aPhase', new BufferAttribute(phase, 1));
    return buffer;
  }, [count, field, seed]);

  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  const points = useRef<Points>(null);
  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <points ref={points} geometry={geometry} material={material} />;
}
