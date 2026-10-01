/**
 * Voda (P32A T9, ukázka B): stylizovaná hladina s vlnami ve vertex shaderu
 * a pěnou u břehu. Mřížka s posunutými vrcholy leží rovně ve výšce `level`,
 * vlny (`WAVES`) přičítá až shader a plošky stínuje po plochách z derivací
 * (`flatShading`) – vlnu zná jen GPU, zapečená normála by zůstala rovná.
 * U břehu je voda světlejší (barva ve vrcholech) a pění: vzdálenost ke břehu
 * nese atribut `shore` (u ostrůvků `Islands.shoreDistance`), pěnu kreslí
 * fragment shader a vlní ji časem.
 *
 * Jen obraz: jádro o vodě neví, do kolizí ani hashovaného stavu nic nepíše.
 * Čas vln jsou hodiny stěny (`setTime` z `useFrame`), ne tik hry. Síť stín jen
 * přijímá (`userData.rigShadow = 'receive'`) – vlastní stín by byl rovný.
 */

import { BufferGeometry, Color, Float32BufferAttribute, MeshStandardMaterial } from 'three';

import type { Look } from '@/play/arcade/look';

import { hash, mix, smooth } from './valley';

/** Vlny: směr (x, z), délka a výška (m), rychlost (m/s). Totéž čte shader i `heightAt`. */
const WAVES = [
  [0.8, 0.6, 9, 0.11, 1.1],
  [-0.5, 0.866, 6.5, 0.07, 1.5],
  [0.2, -0.98, 4.2, 0.045, 1.9],
] as const;

/** Nejvyšší výchylka hladiny (m). */
export const WAVE_HEIGHT = WAVES.reduce((sum, wave) => sum + wave[3], 0);

/** Krok mřížky (m) a pás mělčiny u břehu (m). */
const CELL = 1.6;
const SHALLOW = 6;
/**
 * „Daleko od břehu“ (m, strop atributu `shore`). Dál se obraz nemění: barva končí
 * v `SHALLOW`, pěna u ~1,5 m a trojúhelník mřížky (úhlopříčka pod 4 m) strop do
 * pásu, kde něco kreslí, nedotáhne. Strop zároveň šetří výpočet – ostrov dál od
 * vrcholu se neměří (P35 T4: pirát na Pixel 7 se 4× CPU počítal se stropem 100 m
 * pobřeží ~8 s a v O10 se nenačetl do 30 s).
 */
export const OPEN_SEA = 2 * SHALLOW;

const f = (value: number): string => value.toFixed(5);
const k = (length: number): number => (2 * Math.PI) / length;

const WAVE_GLSL = /* glsl */ `
uniform float uTime;
float waveHeight(vec2 p, float t) {
  return ${WAVES.map(([dx, dz, length, height, speed]) => `${f(height)} * sin(${f(k(length))} * dot(p, vec2(${f(dx)}, ${f(dz)})) + t * ${f(k(length) * speed)})`).join('\n    + ')};
}`;

export interface WaterPalette {
  readonly deep: string;
  readonly shallow: string;
  readonly foam: string;
}

/** Hladina sady, u břehu světlejší, pěna skoro bílá v odstínu vody. */
export function waterPalette(look: Look): WaterPalette {
  return { deep: look.water, shallow: mix(look.water, '#ffffff', 0.3), foam: mix(look.water, '#ffffff', 0.85) };
}

export interface Water {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
  /** Posune vlny a pěnu na čas `seconds` (hodiny stěny). */
  setTime(seconds: number): void;
  /** Výška hladiny v bodě scény v čase `seconds` – tatáž vlna, kterou kreslí vertex shader. */
  heightAt(x: number, z: number, seconds: number): number;
}

export interface WaterOptions {
  readonly look: Look;
  /** Obdélník hladiny ve scéně (m): x od −half do half, z od `from` do `to`. */
  readonly half: number;
  readonly from: number;
  readonly to: number;
  /** Výška klidné hladiny (m). */
  readonly level: number;
  /** Vzdálenost ke břehu (m, na souši záporná), nejvýš `within`; bez ní volné moře bez pěny. */
  readonly shore?: (x: number, z: number, within: number) => number;
}

export function buildWater({ look, half, from, to, level, shore }: WaterOptions): Water {
  const columns = Math.max(1, Math.round((2 * half) / CELL));
  const rows = Math.max(1, Math.round((to - from) / CELL));
  const [cx, cz] = [(2 * half) / columns, (to - from) / rows];
  const count = (columns + 1) * (rows + 1);
  const positions = new Float32Array(count * 3);
  const tints = new Float32Array(count * 3);
  const distances = new Float32Array(count);
  const palette = waterPalette(look);
  const [deep, shallow] = [new Color(palette.deep), new Color(palette.shallow)];
  const tint = new Color();
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      // Vnitřní vrcholy posunuté: plošky vln pak nejdou v pravidelných pruzích.
      const inner = row > 0 && row < rows && column > 0 && column < columns;
      const x = -half + column * cx + (inner ? (hash(column, row + 7000) - 0.5) * 0.6 * cx : 0);
      const z = from + row * cz + (inner ? (hash(column + 9000, row) - 0.5) * 0.6 * cz : 0);
      const at = row * (columns + 1) + column;
      const distance = Math.min(shore?.(x, z, OPEN_SEA) ?? OPEN_SEA, OPEN_SEA);
      positions.set([x, level, z], at * 3);
      distances[at] = distance;
      tint.copy(deep).lerp(shallow, 1 - smooth(distance / SHALLOW)).multiplyScalar(0.96 + 0.08 * hash(column + 300, row + 300));
      tints.set([tint.r, tint.g, tint.b], at * 3);
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      // Rohy buňky a (sloupec, řada), b (+1, řada), c (+1, +1), d (sloupec, +1); pořadí dává normálu nahoru.
      const a = row * (columns + 1) + column;
      const [b, c, d] = [a + 1, a + columns + 2, a + columns + 1];
      if (hash(column * 7 + 5, row) < 0.5) indices.push(a, d, b, b, d, c);
      else indices.push(a, c, b, a, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(tints, 3));
  geometry.setAttribute('shore', new Float32BufferAttribute(distances, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const time = { value: 0 };
  const foam = { value: new Color(palette.foam) };
  const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.3, metalness: 0.05 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uFoamColor = foam;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WAVE_GLSL}\nattribute float shore;\nvarying float vShore;\nvarying float vCrest;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n\tfloat wave = waveHeight(transformed.xz, uTime);\n\ttransformed.y += wave;\n\tvShore = shore;\n\tvCrest = wave / ${f(WAVE_HEIGHT)};`,
      );
    // Pěna: pás u břehu, který dýchá s časem, a slabší čepice na hřebenech vln.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uFoamColor;\nvarying float vShore;\nvarying float vCrest;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
\tfloat surf = vShore + 0.3 * sin(uTime * 1.7 + vShore * 2.4);
\tfloat foam = max(1.0 - smoothstep(0.35, 1.1, surf), 0.4 * smoothstep(0.7, 1.0, vCrest));
\tdiffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, clamp(foam, 0.0, 1.0));`,
      );
  };
  material.customProgramCacheKey = () => 'p32-water';

  const heightAt = (x: number, z: number, seconds: number): number =>
    level + WAVES.reduce((sum, [dx, dz, length, height, speed]) => sum + height * Math.sin(k(length) * (x * dx + z * dz) + seconds * k(length) * speed), 0);

  return {
    geometry,
    material,
    setTime: (seconds) => {
      time.value = seconds;
    },
    heightAt,
  };
}
