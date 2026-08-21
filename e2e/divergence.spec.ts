import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';

import { allPairs, coverage, mean, type Frame } from '../evals/measure-divergence';
import { compileGeomProgram } from '../src/geom/compile';
import { FAMILIES } from '../src/geom/families';
import { PALETTES, repaint } from '../src/kit';

/**
 * Oracle úlohy T10 — **čtyři rodiny jsou vidět jako čtyři, ne jako jedna**.
 *
 * Každá rodina se vyrenderuje ze dvou semínek, ze snímků se spočítá odlišnost
 * podle `evals/measure-divergence.ts` a proti prahu stojí dvě tvrzení naráz:
 *
 * 1. **Průměr přes dvojice napříč rodinami musí být nad prahem.** To je to, co
 *    zadání žádá: rodiny se od sebe liší.
 * 2. **Každá dvojice uvnitř jedné rodiny musí být pod prahem.** Bez tohohle by
 *    prahem prošla i metrika, která hlásí velké číslo pro libovolné dva
 *    snímky — a „rodiny se liší" by pak neznamenalo nic.
 * 3. **Profil siluety se soudí zvlášť a po dvojicích.** Celková odlišnost je
 *    průměr palety a profilu, jenže paleta dává 0,85 až 1,00 a profil 0,03 až
 *    0,12 — takže o prahu (1) rozhoduje paleta a o siluetě nedokazuje nic.
 *    Naměřeno 21. 8. 2026: rodina, které se podstrčila cizí geometrie a nechala
 *    si vlastní paletu, prošla se 0,507 proti 0,514 čisté sady. Proto tu stojí
 *    vlastní podlaha na profilu, a stojí na **každé** dvojici — v průměru se
 *    jedna splynulá dvojice schová za zbylých třiadvacet.
 *
 * **Renderuje se tady, ne přes plátno aplikace.** Měří se program geometrie,
 * ne viewer: kontext je skutečný WebGL2 (SwiftShader), shader je lambert nad
 * barvou vrcholu, kamera je pevná pro všechny rodiny — kdyby se rámovalo podle
 * každého světa zvlášť, splynuly by proporce, které jsou právě tím, co se měří.
 * Snímky se **neporovnávají s ničím uloženým**, jen mezi sebou v témž běhu,
 * takže varování `TOOLING.md` §1 o screenshot diffech přes SwiftShader se sem
 * nevztahuje.
 */

// Playwright překládá spec do CJS, takže `import.meta.url` tu není. Cesta jde
// od kořene repozitáře — odtud se `playwright test` spouští.
const THRESHOLD: {
  readonly minMeanCrossFamily: number;
  readonly maxSameFamily: number;
  readonly minCrossFamilyProfile: number;
  readonly maxSameFamilyProfile: number;
} = JSON.parse(readFileSync(resolve(process.cwd(), 'src/geom/families/threshold.json'), 'utf-8'));

const SIZE = 192;
const SEEDS = [101, 202] as const;
const LIGHT = new Vector3(0.4, 0.85, 0.3).normalize();

/** Pevná kamera pro všechny rodiny. Rámuje nejširší svět (44 polí) s rezervou. */
function viewProjection(): readonly number[] {
  const camera = new PerspectiveCamera(45, 1, 0.5, 300);
  camera.position.set(54, 34, 54);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray();
}

interface Upload {
  readonly position: string;
  readonly color: string;
  readonly normal: string;
  readonly vertices: number;
}

/** Zkompiluje program rodiny, přebarví ho její paletou a připraví k odeslání do stránky. */
function upload(familyId: string, seed: number): Upload {
  const family = FAMILIES.find((candidate) => candidate.id === familyId)!;
  const geometry = compileGeomProgram(family.compose(seed));
  repaint(geometry, PALETTES[family.palette]);

  const base64 = (name: string) =>
    Buffer.from((geometry.getAttribute(name).array as Float32Array).buffer).toString('base64');

  const packed = {
    position: base64('position'),
    color: base64('color'),
    normal: base64('normal'),
    vertices: geometry.getAttribute('position').count,
  };
  geometry.dispose();
  return packed;
}

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aColor;
in vec3 aNormal;
uniform mat4 uViewProjection;
uniform vec3 uLight;
out vec3 vColor;
void main() {
  float lambert = max(dot(normalize(aNormal), uLight), 0.0);
  vColor = aColor * (0.3 + 0.7 * lambert);
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  // Barvy jdou z kitu lineární; do obrazu se kódují gamou, jinak by rozdíl
  // palet vycházel jinak, než jak ho člověk na obrazovce uvidí.
  outColor = vec4(pow(vColor, vec3(1.0 / 2.2)), 1.0);
}`;

test('@measure čtyři rodiny se od sebe liší a dvě semínka jedné rodiny ne', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('about:blank');

  const frames = new Map<string, Frame>();

  for (const family of FAMILIES) {
    for (const seed of SEEDS) {
      const packed = upload(family.id, seed);
      const encoded = await page.evaluate(
        async ({ packed, size, viewProjection, light, vertexShader, fragmentShader }) => {
          const decode = (base64: string): Float32Array => {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return new Float32Array(bytes.buffer);
          };

          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const gl = canvas.getContext('webgl2', {
            antialias: false,
            alpha: true,
            preserveDrawingBuffer: true,
          });
          if (gl === null) throw new Error('stránka nedostala WebGL2 kontext');

          const compile = (type: number, source: string): WebGLShader => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
              throw new Error(`shader se nepřeložil: ${gl.getShaderInfoLog(shader)}`);
            }
            return shader;
          };

          const shaderProgram = gl.createProgram()!;
          gl.attachShader(shaderProgram, compile(gl.VERTEX_SHADER, vertexShader));
          gl.attachShader(shaderProgram, compile(gl.FRAGMENT_SHADER, fragmentShader));
          gl.linkProgram(shaderProgram);
          if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
            throw new Error(`program se nesestavil: ${gl.getProgramInfoLog(shaderProgram)}`);
          }
          gl.useProgram(shaderProgram);

          for (const [name, base64] of [
            ['aPosition', packed.position],
            ['aColor', packed.color],
            ['aNormal', packed.normal],
          ] as const) {
            const location = gl.getAttribLocation(shaderProgram, name);
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, decode(base64), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
          }

          gl.uniformMatrix4fv(
            gl.getUniformLocation(shaderProgram, 'uViewProjection'),
            false,
            new Float32Array(viewProjection),
          );
          gl.uniform3fv(gl.getUniformLocation(shaderProgram, 'uLight'), new Float32Array(light));

          gl.viewport(0, 0, size, size);
          gl.enable(gl.DEPTH_TEST);
          // Alfa 0 na pozadí je celé měření siluety — zakrytí se čte z ní.
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, packed.vertices);

          const pixels = new Uint8Array(size * size * 4);
          gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

          let binary = '';
          const chunk = 0x8000;
          for (let index = 0; index < pixels.length; index += chunk) {
            binary += String.fromCharCode(...pixels.subarray(index, index + chunk));
          }
          return btoa(binary);
        },
        {
          packed,
          size: SIZE,
          viewProjection: viewProjection(),
          light: [LIGHT.x, LIGHT.y, LIGHT.z],
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
        },
      );

      frames.set(`${family.id}#${seed}`, {
        width: SIZE,
        height: SIZE,
        pixels: new Uint8Array(Buffer.from(encoded, 'base64')),
      });
    }
  }

  for (const [name, frame] of frames) {
    expect(coverage(frame), `${name}: scéna nesmí být prázdná`).toBeGreaterThan(0.05);
  }

  const pairs = allPairs(frames);
  const familyOf = (key: string) => key.split('#')[0];
  const cross = pairs.filter((pair) => familyOf(pair.first) !== familyOf(pair.second));
  const same = pairs.filter((pair) => familyOf(pair.first) === familyOf(pair.second));

  for (const pair of [...cross, ...same]) {
    const { palette, profile, total } = pair.divergence;
    console.log(
      `${pair.first} vs ${pair.second}: paleta ${palette.toFixed(3)} profil ${profile.toFixed(3)} celkem ${total.toFixed(3)}`,
    );
  }

  expect(same, 'každá rodina musí mít dvojici semínek k porovnání').toHaveLength(FAMILIES.length);

  const crossMean = mean(cross.map((pair) => pair.divergence.total));
  const weakestProfile = Math.min(...cross.map((pair) => pair.divergence.profile));
  console.log(`\nprůměr napříč rodinami ${crossMean.toFixed(3)}, práh ${THRESHOLD.minMeanCrossFamily}`);
  console.log(
    `nejslabší profil napříč rodinami ${weakestProfile.toFixed(3)}, podlaha ${THRESHOLD.minCrossFamilyProfile}`,
  );
  expect(crossMean, 'rodiny se od sebe musí lišit').toBeGreaterThanOrEqual(THRESHOLD.minMeanCrossFamily);

  for (const pair of cross) {
    expect(
      pair.divergence.profile,
      `${pair.first} vs ${pair.second}: dvě rodiny nesmějí sdílet siluetu, i když mají jinou paletu`,
    ).toBeGreaterThanOrEqual(THRESHOLD.minCrossFamilyProfile);
  }

  for (const pair of same) {
    expect(
      pair.divergence.total,
      `${pair.first} vs ${pair.second}: dvě semínka jedné rodiny prahem projít nesmí`,
    ).toBeLessThan(THRESHOLD.maxSameFamily);
    expect(
      pair.divergence.profile,
      `${pair.first} vs ${pair.second}: semínko smí přesunout kusy, ne změnit siluetu rodiny`,
    ).toBeLessThan(THRESHOLD.maxSameFamilyProfile);
  }
});
