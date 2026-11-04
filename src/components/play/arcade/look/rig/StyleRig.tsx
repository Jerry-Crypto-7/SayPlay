'use client';

/**
 * Rig vzhledu (P32A T1) scén, které si světla nestaví samy: běžec, plošinovka,
 * poletování, závod, střelnice, hod, aréna, od T10 načasování a rytmus a od
 * P37B T3 i souboj (dřív plochá barva pozadí bez stínu a mlhy).
 *
 * Kreslí to, co ukázka B (`D:/caches/p32-style/page.html`, `renderVariant('B')`):
 * kreslenou oblohu s přechodem obzor → zenit a sluncem, mlhu v barvě obzoru,
 * polokulové světlo a slunce se stínem 2048 v těsném výřezu, který jede
 * s hrdinou, ACES s expozicí z palety. Hodnoty nese paleta sady
 * (`@/play/arcade/look`), rig je jen čte. AO, bloom a SMAA podle úrovně
 * kvality přidává `Post.tsx` (T2).
 *
 * Mimo hash: světlo, obloha ani stín jádro nečtou.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { ACESFilmicToneMapping, BackSide, Color, type DirectionalLight, type Mesh, type Object3D, type PerspectiveCamera, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from 'three';

import { type Look, type LookId, NIGHT } from '@/play/arcade/look';

import { Ambient } from '../Ambient';
import { setCharacterRim } from '../load';
import { darkness, setScenePalette } from './toon';
import { Wind } from '../Vegetation';
import { airOf, liftLight, SHADOW_RADIUS } from './fog-light';
import { LOOK_FAMILY } from './grade';
import { Post, useQualityTier } from './Post';
import { TIER_SETTINGS } from './quality';

/**
 * Kamera končí tam, kde mlha (P28E-R1). Za koncem mlhy má každý pixel barvu oblohy,
 * takže to, co ořízne vzdálená rovina, by vypadalo stejně – jen se to nekreslí.
 * Běžec tak nekreslí celou trať (Moto G Power emulace: 416 volání na snímek, 10 fps).
 * Mlha i vzdálená rovina měří hloubku v prostoru kamery, hranice sedí přesně.
 */
function FarAtFog({ far }: { readonly far: number }) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  useEffect(() => {
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, far]);
  return null;
}

/** Plošinovka, poletování a souboj koukají z boku po +x, ostatní scény po +z. */
const SIDE_VIEW: ReadonlySet<string> = new Set(['platform', 'flap', 'duel']);

/**
 * Směr z pohledu kamery (vlevo, nahoru, dopředu) do světa scény. Kamera po +z
 * má vlevo +x (scéna zrcadlí x jádra), boční kamera na −x kouká po +x a vlevo má −z.
 */
function viewToWorld([left, up, forward]: readonly [number, number, number], control: string): Vector3 {
  return (SIDE_VIEW.has(control) ? new Vector3(forward, up, -left) : new Vector3(left, up, forward)).normalize();
}

/**
 * Kam na obloze patří záře slunce. Ukázka B svítí zezadu, ale záři kreslí vpředu
 * nízko nad obzorem na opačné straně než světlo: kamera se dívá do světlého konce údolí.
 */
function glowDirOf(sunDir: Look['sunDir'], control: string): Vector3 {
  return viewToWorld([-sunDir[0] * 0.8, 0.35, 1], control);
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // Jen otočení kamery, bez posunu: obloha je nekonečně daleko a jede s kamerou.
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}`;

// Přechod a slunce z ukázky B; tón a barevný prostor jako u ostatních materiálů scény.
// Hala (P61 T7, `Look.ceiling`): nahoře strop – paprsek z kamery k rovině stropu, světla v mřížce světa (jedou
// kolem, když kamera jede), v dálce mizí do barvy obzoru jako mlha scény. Slepý soudce četl halu bez stropu jako venku.
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 sunColor;
uniform vec3 sunDir;
uniform float glow;
uniform float indoor;
uniform vec3 ceiling;
uniform vec3 lamp;
uniform vec2 haze;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  float h = clamp(dir.y * 2.2, 0.0, 1.0);
  vec3 color = mix(horizon, top, pow(h, 0.7));
  float s = max(dot(dir, sunDir), 0.0);
  color += sunColor * glow * (pow(s, 600.0) * 1.5 + pow(s, 12.0) * 0.25);
  if (indoor > 0.5 && dir.y > 0.0) {
    float t = max(CEILING_Y - cameraPosition.y, CEILING_MIN) / dir.y;
    vec2 off = abs(fract((cameraPosition.xz + dir.xz * t) / LAMP_GRID) - 0.5) * LAMP_GRID;
    float edge = 0.015 * t;
    float lit = (1.0 - smoothstep(LAMP_HALF.x - edge, LAMP_HALF.x + edge, off.x)) * (1.0 - smoothstep(LAMP_HALF.y - edge, LAMP_HALF.y + edge, off.y));
    color = mix(mix(ceiling, lamp * 1.5, lit), horizon, smoothstep(haze.x, haze.y, t));
  }
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Strop haly (m): výška nad zemí, nejmenší odstup nad kamerou (kamera arény nad stropem), rozteč světel a půl
 * rozměru světla napříč a podél. simplified: rovina se světly v mřížce, bez trámů a stěn až ke kameře.
 */
const CEILING = { y: 9, min: 3, grid: 6, half: [1.4, 0.45] } as const;

/** Kreslí se první, bez hloubky: všechno ostatní leží před ní, i zem pod panoramatem (`UNDER_PANORAMA`). */
const SKY_ORDER = -10;

/** Materiál oblohy; barvy nastaví `paintSky`. */
export function skyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      top: { value: new Color() },
      horizon: { value: new Color() },
      sunColor: { value: new Color() },
      sunDir: { value: new Vector3() },
      glow: { value: 0 },
      indoor: { value: 0 },
      ceiling: { value: new Color() },
      lamp: { value: new Color() },
      haze: { value: new Vector2() },
    },
    defines: { CEILING_Y: CEILING.y.toFixed(1), CEILING_MIN: CEILING.min.toFixed(1), LAMP_GRID: CEILING.grid.toFixed(1), LAMP_HALF: `vec2(${CEILING.half.map((m) => m.toFixed(2)).join(', ')})` },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    // Kamera je uvnitř koule.
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
}

/**
 * Barvy sady do uniforem oblohy; hala (`Look.ceiling`) zapne strop, mlha sady ho v dálce rozpustí.
 * Obzor má barvu mlhy (`airOf`, P70D T2): terén v dálce mizí do téže barvy, kterou má obloha za ním.
 */
export function paintSky(material: ShaderMaterial, look: Look, control: string): void {
  const { uniforms } = material;
  const air = airOf(look);
  (uniforms.top!.value as Color).set(look.skyTop);
  (uniforms.horizon!.value as Color).set(air.color);
  (uniforms.sunColor!.value as Color).set(look.sunColor);
  (uniforms.sunDir!.value as Vector3).copy(glowDirOf(look.sunDir, control));
  uniforms.glow!.value = look.glow;
  uniforms.indoor!.value = look.ceiling === undefined ? 0 : 1;
  if (look.ceiling !== undefined) {
    (uniforms.ceiling!.value as Color).set(look.ceiling.color);
    (uniforms.lamp!.value as Color).set(look.ceiling.lamp);
  }
  (uniforms.haze!.value as Vector2).set(air.near, air.far);
}

function Sky({ look, control }: { readonly look: Look; readonly control: string }) {
  const geometry = useMemo(() => new SphereGeometry(1, 32, 16), []);
  const material = useMemo(skyMaterial, []);
  useEffect(() => paintSky(material, look, control), [material, look, control]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  return <mesh geometry={geometry} material={material} renderOrder={SKY_ORDER} frustumCulled={false} userData={{ rigShadow: 'none' }} />;
}

/** Lineární jas `#rrggbb`. */
const luminanceOf = (hex: string): number => {
  const { r, g, b } = new Color(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Světlo na matné ploše jako `brightness` v katalogu: polokoule shora a slunce. */
const brightnessOf = (look: Pick<Look, 'light' | 'sun' | 'sunColor'>): number => look.light[2] * luminanceOf(look.light[0]) + look.sun * luminanceOf(look.sunColor);

/**
 * Tmavá sada bez noci a nálady (hřbitov, jeskyně) nesvítí slaběji než noc (P56B T7) – stejná mez,
 * jakou katalog dává náladám (`withMood`); noc a nálady ji už mají, pro ně je to beze změny.
 */
export function lightFloor(look: Look): Pick<Look, 'light' | 'sun'> {
  const lift = brightnessOf(NIGHT) / brightnessOf(look);
  return lift <= 1 ? look : { light: [look.light[0], look.light[1], look.light[2] * lift], sun: look.sun * lift };
}

/**
 * Kolikrát noc zvedne expozici (P56B T7): oko přivyklé tmě, jinak je noc skoro černá (audit 21. 10.).
 * 2,4× přepálilo světlou výplň (náhrobky, lavičky, keře) do bílé a slepý soud to označil (T13-R1); 1,3× drží noc nad dneškem.
 */
export const NIGHT_EXPOSURE = 1.3;

/**
 * Expozice sady se světlem po `lightFloor`: tmavá obloha (`darkness`) a světlo u noční meze ji zvednou až na
 * `NIGHT_EXPOSURE`×; se světlem dvojnásobku noci (vesmír se sluncem) a pod světlou oblohou (bouřka, mlha) zůstane.
 */
export function exposureOf(look: Look): number {
  const dim = Math.min(Math.max(2 - brightnessOf(look) / brightnessOf(NIGHT), 0), 1);
  return look.exposure * (1 + (NIGHT_EXPOSURE - 1) * darkness(look) * dim);
}

/** Jak daleko před hrdinou je střed výřezu stínu (m) – kamera se dívá dopředu. Polovina hrany je z úrovně kvality. */
const SHADOW_LEAD = 6;
const SUN_DISTANCE = 40;

const heroOf = (scene: Object3D): Object3D | null => {
  let hero: Object3D | null = null;
  scene.traverse((node) => {
    if (hero === null && node.userData.frame === 'hero') hero = node;
  });
  return hero;
};

/**
 * Slunce se stínem, jehož výřez jede s hrdinou (`userData.frame = 'hero'`, stejná
 * značka jako sonda záběru), dokud ho scéna nemá, s kamerou. Hrdina je ze snímku
 * předtím – posun výřezu o jeden snímek stín nepohne, ten závisí jen na tělech.
 */
function Sun({ look, sun: intensity, control, mapSize, half }: { readonly look: Look; readonly sun: number; readonly control: string; readonly mapSize: number; readonly half: number }) {
  const light = useRef<DirectionalLight>(null);
  const scene = useThree((three) => three.scene);
  const toSun = useMemo(() => viewToWorld(look.sunDir, control).multiplyScalar(SUN_DISTANCE), [look, control]);
  const ahead = useMemo(() => viewToWorld([0, 0, 1], control).multiplyScalar(Math.min(SHADOW_LEAD, half / 2)), [control, half]);
  const hero = useRef<Object3D | null>(null);
  const frames = useRef(0);
  const at = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const sun = light.current;
    if (sun === null) return;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: SUN_DISTANCE * 2 });
    sun.shadow.camera.updateProjectionMatrix();
  }, [half]);

  // Nová velikost (úroveň kvality) se projeví až s novou mapou; renderer ji vytvoří sám.
  useEffect(() => {
    const sun = light.current;
    if (sun === null || sun.shadow.map === null) return;
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }, [mapSize]);

  useFrame(({ camera }) => {
    const sun = light.current;
    if (sun === null) return;
    // Hrdinu hledat jen občas: projít scénu každý snímek je zbytečné, hrdina se mění jen s novou hrou.
    if ((hero.current === null || hero.current.parent === null) && frames.current++ % 30 === 0) hero.current = heroOf(scene);
    if (hero.current !== null && hero.current.parent !== null) hero.current.getWorldPosition(at);
    else at.copy(camera.position);
    at.add(ahead);
    sun.target.position.copy(at);
    sun.target.updateMatrixWorld();
    sun.position.copy(at).add(toSun);
  });

  return <directionalLight ref={light} color={look.sunColor} intensity={intensity} castShadow shadow-mapSize={[mapSize, mapSize]} shadow-bias={-0.0005} shadow-normalBias={0.02} shadow-radius={SHADOW_RADIUS} />;
}

/**
 * Stíny bez zásahu do scén: rig jednou označí každou síť, která přibude. Rovné
 * plochy (země, dráha, čáry) a plochy bez hloubky stín jen přijímají – vrhaly by ho
 * samy na sebe.
 */
function ShadowFlags() {
  const scene = useThree((three) => three.scene);
  const frames = useRef(0);
  useFrame(() => {
    if (frames.current++ % 30 !== 0) return;
    scene.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh === true && mesh.userData.rigShadow === undefined) flagShadow(mesh);
    });
  });
  return null;
}

/**
 * Označí jednu síť jako `ShadowFlags`. Obrys (`inkMeshes`) to volá hned na síti, kterou
 * obtáhne: plošný průchod jede jen každý 30. snímek a na pomalém telefonu by hrdina
 * po dotažení modelu sekundy stál bez stínu.
 */
export function flagShadow(mesh: Mesh): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const flat = mesh.geometry.type === 'PlaneGeometry' || materials.some((material) => !material.depthWrite || material.transparent);
  mesh.userData.rigShadow = flat ? 'receive' : 'both';
  mesh.receiveShadow = true;
  mesh.castShadow = !flat;
}

/** Rezerva za koncem mlhy na velikost kulisy (počítá se od její paty, vršek může sahat blíž). */
const SCENERY_MARGIN_M = 12;
const propAt = new Vector3();

/**
 * Kulisa za koncem mlhy (`FarAtFog`) by se stejně nenakreslila, ale scéna by ji
 * každý snímek procházela: přepočet matic a ořez kamerou i stínem. Běžec jich má
 * podél celé trati stovky (Pixel 7 se 4× CPU ~20 FPS). Jako těla ve `World` (P28E-R1):
 * mimo dosah neviditelné a bez přepočtu. Řady kulis značí `userData.scenery` (`Scenery.tsx`).
 */
function SceneryWindow() {
  const scene = useThree((three) => three.scene);
  const rows = useRef<Object3D[]>([]);
  const frames = useRef(0);
  useFrame(({ camera }) => {
    if (frames.current++ % 30 === 0) {
      rows.current = [];
      scene.traverse((node) => {
        if (node.userData.scenery === true) rows.current.push(node);
      });
    }
    const reach = (camera as PerspectiveCamera).far + SCENERY_MARGIN_M;
    for (const row of rows.current) {
      for (const prop of row.children) {
        const near = propAt.setFromMatrixPosition(prop.matrixWorld).distanceTo(camera.position) <= reach;
        prop.visible = near;
        prop.matrixWorldAutoUpdate = near;
      }
    }
  });
  return null;
}

/** ACES s expozicí sady; po odchodu scény plátno vrátí, co mělo. */
function Exposure({ exposure }: { readonly exposure: number }) {
  const gl = useThree((three) => three.gl);
  useEffect(() => {
    const before = { toneMapping: gl.toneMapping, exposure: gl.toneMappingExposure };
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = exposure;
    return () => {
      gl.toneMapping = before.toneMapping;
      gl.toneMappingExposure = before.exposure;
    };
  }, [gl, exposure]);
  return null;
}

export function StyleRig({ look, lookId, control, surface }: { readonly look: Look; readonly lookId: LookId; readonly control: string; readonly surface: RefObject<HTMLDivElement | null> }) {
  const tier = useQualityTier(surface);
  const lit = useMemo(() => ({ ...look, ...lightFloor(look) }), [look]);
  // Expozice se počítá ze světla sady (noc zvedá dál stejně), zvednutí jen přisvítí scénu (P70D T2).
  const shine = useMemo(() => liftLight(lit), [lit]);
  const air = useMemo(() => airOf(look), [look]);
  // Okrajový svit postav barvou oblohy sady (P54B T14): jen uniformy, materiály se nepřekládají.
  // Paleta, přimíchání a okraj toonu sady (P56B T6): také jen uniformy.
  useEffect(() => {
    setCharacterRim(look);
    setScenePalette(look);
  }, [look]);
  return (
    <>
      <color attach="background" args={[air.color]} />
      <fog attach="fog" args={[air.color, air.near, air.far]} />
      <FarAtFog far={air.far} />
      <Exposure exposure={exposureOf(lit)} />
      <Sky look={look} control={control} />
      <hemisphereLight args={[...shine.light]} />
      <Sun look={look} sun={shine.sun} control={control} mapSize={TIER_SETTINGS[tier].shadowMapSize} half={TIER_SETTINGS[tier].shadowHalf} />
      <ShadowFlags />
      <SceneryWindow />
      {/* Život v pozadí kolem orientačního bodu scény (P54B T10) a vítr ve vegetaci (T13). */}
      <Ambient look={look} tier={tier} />
      <Wind look={look} lookId={lookId} tier={tier} />
      <Post look={look} family={LOOK_FAMILY[lookId]} tier={tier} />
    </>
  );
}
