import { expect, test } from '@playwright/test';
import { ACESFilmicToneMapping, Matrix4, PCFSoftShadowMap, PerspectiveCamera, Vector3 } from 'three';

import { compileGeomProgram } from '../src/geom/compile';
import { FAMILIES } from '../src/geom/families';
import { KIT_BUDGETS, VIEWER_BUDGETS, trianglesOf } from '../src/kit/budgets';
import { MIN_FIGURE_GROUND_SEPARATION, PALETTES, repaint } from '../src/kit/palettes';
import { FOG, KEY_LIGHT, SHADOW_MAP_TYPE, TOON_LEVELS } from '../src/components/viewer/Lighting';

/**
 * Oracle úlohy T6 — **rig je opravdu zapnutý a snímek se vejde do rozpočtu**.
 *
 * Ptá se rendereru, ne zdrojáku. To je celý smysl: `antialias` je atribut
 * kontextu, který ovladač smí odmítnout, `shadowMap.enabled` nastavuje R3F za
 * nás, a `calls` sčítá i stínový průchod, který ve scéně vidět není. Ani jedno
 * se ze zdrojáku odvodit nedá, takže grep by tu netvrdil nic.
 *
 * **Rozpočet se měří na nejtěžším layoutu, ne na prvním.** Layouty kitu se liší
 * počtem umístěných kusů; kdyby se měřil jen ten, se kterým se stránka načte,
 * prošel by strop i scéna, která ho pětkrát překročí hned po přepnutí.
 *
 * Čísla stropu drží `data/profiles/web-viewer.json` přes `VIEWER_BUDGETS` —
 * jedna kopie, kterou hlídá `src/kit/__tests__/budgets.test.ts`.
 */

const SETTLE_FRAMES = 3;

interface LayoutSample {
  readonly layout: string;
  readonly calls: number;
  readonly triangles: number;
}

test('plátno má zapnutý rig a vejde se do rozpočtu snímku', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/embed/harbor-pier');
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  const stats = await page.evaluate(async (frames): Promise<ReturnType<NonNullable<Window['__viewer']>['render']>> => {
    const viewer = window.__viewer!;
    const from = viewer.frames();
    while (viewer.frames() < from + frames) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    return viewer.render();
  }, SETTLE_FRAMES);

  expect(stats.toneMapping, 'tone mapping musí být ACES Filmic').toBe(ACESFilmicToneMapping);
  expect(stats.toneMappingExposure, 'ACES bez korekce expozice scénu ztmaví').toBeGreaterThan(1);
  expect(stats.shadowMapEnabled, 'bez stínové mapy se nic nedotýká podlahy').toBe(true);
  expect(stats.shadowMapType, 'renderer musí mít ten druh mapy, který mu nastavíme').toBe(
    SHADOW_MAP_TYPE,
  );
  // Tahle aserce má jméno vady, kvůli které tu je: three 0.185.1 označilo
  // `PCFSoftShadowMap` za zastaralý a `WebGLShadowMap.render()` si ho při
  // prvním snímku přepíše na tvrdý `PCFShadowMap`. Nastavení tedy nestačí
  // napsat, musí se změřit — jinak by scéna tiše měla ostré hrany stínu.
  expect(stats.shadowMapType, 'zastaralý typ si three přepíše na tvrdý sám').not.toBe(
    PCFSoftShadowMap,
  );
  expect(stats.antialias, 'kontext musí mít vyhlazování hran').toBe(true);
  expect(stats.fog, 'mlha musí existovat, jinak nemá scéna hloubku').not.toBeNull();
  expect(stats.fog!.color, 'mlha má barvu stránky, jinak vzdálený kus zbělá').toBe(FOG.color);
  expect(stats.fog!.near, 'pásmo mlhy musí být pásmo, ne bod').toBeLessThan(stats.fog!.far);
  expect(
    stats.lights,
    'rig je tři směrová a jedno polokulové — páté světlo je změna návrhu, ne detail',
  ).toBe(VIEWER_BUDGETS.maxLights);

  // Projde všechny layouty a nechá si ten nejtěžší. Strop platí pro každý z
  // nich; kdyby se měřil jen průměr, prošla by scéna, která ho na jednom
  // layoutu překročí dvojnásobně.
  const samples = await page.evaluate(async (frames): Promise<LayoutSample[]> => {
    const viewer = window.__viewer!;
    const settle = async (): Promise<void> => {
      const from = viewer.frames();
      while (viewer.frames() < from + frames) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    };

    const out: LayoutSample[] = [];
    for (let index = 0; index < viewer.layouts.length; index += 1) {
      viewer.switchTo(index);
      await settle();
      const measured = viewer.render();
      out.push({ layout: viewer.layouts[index], calls: measured.calls, triangles: measured.triangles });
    }
    return out;
  }, SETTLE_FRAMES);

  expect(samples.length, 'bez layoutů se rozpočet nedá změřit').toBeGreaterThan(0);
  expect(
    samples.every((sample) => sample.calls > 0),
    `layout, který nekreslí nic, o rozpočtu netvrdí nic: ${JSON.stringify(samples)}`,
  ).toBe(true);

  const heaviestCalls = samples.reduce((worst, sample) => (sample.calls > worst.calls ? sample : worst));
  const heaviestTriangles = samples.reduce((worst, sample) =>
    sample.triangles > worst.triangles ? sample : worst,
  );

  expect(
    heaviestCalls.calls,
    `nejvíc kreslicích volání má ${heaviestCalls.layout}: ${heaviestCalls.calls}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxDrawCallsPerFrame);
  expect(
    heaviestTriangles.triangles,
    `nejvíc trojúhelníků má ${heaviestTriangles.layout}: ${heaviestTriangles.triangles}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxTrianglesPerFrame);
});

/**
 * Oracle úlohy T25 — **čtyři rodiny se vejdou do rozpočtu a čtou se jako světy**.
 *
 * Rodiny (`src/geom/**`) do plátna aplikace nevedou; renderuje je jen měření,
 * stejně jako v `e2e/divergence.spec.ts`. Snímek se proto skládá tady, ale
 * **nasvícený rigem produktu** — `KEY_LIGHT` a `TOON_LEVELS` se importují
 * z `Lighting.tsx`, aby se nesoudil vzhled, jaký produkt nemá.
 *
 * **Neporovnává se s uloženým obrázkem.** `TOOLING.md` §1 na to upozorňuje:
 * headless Chromium jede na SwiftShaderu, takže pixelový diff plátna hlásí
 * rozdíly, které nikdo neudělal. Měří se proto veličiny, ne bajty.
 *
 * Dvě kreslení, každé odpovídá na jinou otázku:
 *
 * - **Stínované** — rozláme rampa povrch na stupně? Plochá scéna bez stupňů je
 *   přesně to, co bylo na snímcích vidět jako „nic tam není".
 * - **Ploché** (bez lambertu) — kolik plochy zabírá zem a kolik to, co na ní
 *   stojí. Ze stínovaného snímku se to spočítat NEDÁ: jeden odstín se v něm
 *   objeví až ve čtyřech jasech podle stupně rampy, takže „dvě nejčastější
 *   barvy" by klidně byly dva stupně téhož odstínu.
 *
 * **Proč se plocha měří modálně, a ne percentilem.** Naměřeno 24. 8. 2026:
 * u Teras vyšlo rozpětí mezi 10. a 90. percentilem jasu **0** — zem zabírá tolik
 * plochy, že oba percentily padnou dovnitř ní a o postaveném obsahu neřeknou nic.
 * Nejčastější a druhá nejčastější barva ho najdou i tak.
 */

const FRAME = 256;
const FAMILY_SEED = 101;

/** Podlaha zaplnění snímku. Svět, který zabírá míň, se na rámování nevejde. */
const MIN_FRAME_COVERAGE = 0.05;

/** Kolik různých jasů musí mít stínovaný snímek. Rig, který nerozlišuje, má jeden. */
const MIN_SHADED_LEVELS = 3;

interface FamilyFrame {
  /** Podíl plochy, na které je vidět svět. */
  readonly coverage: number;
  /** Kolik různých jasů má stínovaný snímek. */
  readonly shadedLevels: number;
  /** Jas nejčastější barvy plochého snímku. To je zem. */
  readonly groundLuminance: number;
  /** Jas druhé nejčastější. To je, co na zemi stojí. */
  readonly figureLuminance: number;
}

const FAMILY_VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aColor;
in vec3 aNormal;
uniform mat4 uViewProjection;
uniform vec3 uLight;
uniform float uShade;
uniform vec4 uRamp;
out vec3 vColor;
void main() {
  float lambert = max(dot(normalize(aNormal), uLight), 0.0);
  // Rampa produktu: ctyri stupne, ne spojity prechod.
  float ramp = lambert < 0.25 ? uRamp.x : lambert < 0.5 ? uRamp.y : lambert < 0.75 ? uRamp.z : uRamp.w;
  vColor = aColor * mix(1.0, ramp, uShade);
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;

const FAMILY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(pow(vColor, vec3(1.0 / 2.2)), 1.0);
}`;

/** Rámuje rodinu podle jejích deklarovaných proporcí, ne pevnou vzdáleností. */
function familyCamera(footprint: number, height: number): readonly number[] {
  const camera = new PerspectiveCamera(45, 1, 0.5, 400);
  const reach = Math.max(footprint, height) * 1.9;
  camera.position.set(reach, reach * 0.72, reach);
  camera.lookAt(0, height * 0.3, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray();
}

test('čtyři rodiny se vejdou do rozpočtu a na snímku se čtou jako svět', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('about:blank');

  const light = new Vector3(...KEY_LIGHT.position).normalize();

  for (const family of FAMILIES) {
    const geometry = compileGeomProgram(family.compose(FAMILY_SEED));
    repaint(geometry, PALETTES[family.palette]);

    // Rozpočet. Program se kompiluje do JEDNÉ `BufferGeometry`, takže svět
    // rodiny je jedno kreslicí volání — proto se počítá zvlášť a ne přes
    // `measureScene`, které chodí po `Object3D`.
    const triangles = trianglesOf(geometry);
    expect(
      triangles,
      `${family.id} překračuje strop trojúhelníků na svět: ${triangles}`,
    ).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
    expect(
      1,
      `${family.id} se musí vejít do stropu kreslicích volání na snímek`,
    ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxDrawCallsPerFrame);

    const base64 = (name: string) =>
      Buffer.from((geometry.getAttribute(name).array as Float32Array).buffer).toString('base64');
    const packed = {
      position: base64('position'),
      color: base64('color'),
      normal: base64('normal'),
      vertices: geometry.getAttribute('position').count,
    };
    geometry.dispose();

    const measured = await page.evaluate(
      async ({
        packed,
        size,
        viewProjection,
        light,
        ramp,
        vertexShader,
        fragmentShader,
      }): Promise<FamilyFrame> => {
        const decode = (value: string): Float32Array => {
          const binary = atob(value);
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

        const program = gl.createProgram()!;
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexShader));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentShader));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(`program se nesestavil: ${gl.getProgramInfoLog(program)}`);
        }
        gl.useProgram(program);

        for (const [name, value] of [
          ['aPosition', packed.position],
          ['aColor', packed.color],
          ['aNormal', packed.normal],
        ] as const) {
          const location = gl.getAttribLocation(program, name);
          gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
          gl.bufferData(gl.ARRAY_BUFFER, decode(value), gl.STATIC_DRAW);
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
        }

        gl.uniformMatrix4fv(
          gl.getUniformLocation(program, 'uViewProjection'),
          false,
          new Float32Array(viewProjection),
        );
        gl.uniform3fv(gl.getUniformLocation(program, 'uLight'), new Float32Array(light));
        gl.uniform4fv(gl.getUniformLocation(program, 'uRamp'), new Float32Array(ramp));
        const shadeAt = gl.getUniformLocation(program, 'uShade');

        gl.viewport(0, 0, size, size);
        gl.enable(gl.DEPTH_TEST);

        /** Jedno kreslení a odečet pixelů. Alfa 0 na pozadí nese siluetu. */
        const draw = (shade: number): Uint8Array => {
          gl.uniform1f(shadeAt, shade);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, packed.vertices);
          const pixels = new Uint8Array(size * size * 4);
          gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };

        const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

        const shaded = draw(1);
        const shadedLevels = new Set<number>();
        let lit = 0;
        for (let index = 0; index < size * size; index += 1) {
          if (shaded[index * 4 + 3] === 0) continue;
          lit += 1;
          shadedLevels.add(
            Math.round(luminance(shaded[index * 4], shaded[index * 4 + 1], shaded[index * 4 + 2])),
          );
        }

        const flat = draw(0);
        const areas = new Map<string, number>();
        for (let index = 0; index < size * size; index += 1) {
          if (flat[index * 4 + 3] === 0) continue;
          const key = `${flat[index * 4]},${flat[index * 4 + 1]},${flat[index * 4 + 2]}`;
          areas.set(key, (areas.get(key) ?? 0) + 1);
        }
        const ranked = [...areas.entries()].sort((a, b) => b[1] - a[1]);
        const luminanceOfKey = (key: string) => {
          const [r, g, b] = key.split(',').map(Number);
          return luminance(r, g, b);
        };

        return {
          coverage: lit / (size * size),
          shadedLevels: shadedLevels.size,
          groundLuminance: ranked.length > 0 ? luminanceOfKey(ranked[0][0]) : 0,
          figureLuminance: ranked.length > 1 ? luminanceOfKey(ranked[1][0]) : 0,
        };
      },
      {
        packed,
        size: FRAME,
        viewProjection: familyCamera(family.proportions.footprint, family.proportions.height),
        light: [light.x, light.y, light.z],
        ramp: TOON_LEVELS.map((level) => level / 255),
        vertexShader: FAMILY_VERTEX_SHADER,
        fragmentShader: FAMILY_FRAGMENT_SHADER,
      },
    );

    expect(
      measured.coverage,
      `${family.id} nezaplnil skoro nic ze snímku: ${(measured.coverage * 100).toFixed(1)} %`,
    ).toBeGreaterThan(MIN_FRAME_COVERAGE);

    // Rig, který nerozlišuje povrchy, vydá jeden jas. Čtyřstupňová rampa přes
    // scénu s vodorovnou zemí a svislými stěnami musí vydat aspoň tři.
    expect(
      measured.shadedLevels,
      `${family.id} je nasvícený naplocho — rampa nerozlomila povrch na stupně`,
    ).toBeGreaterThanOrEqual(MIN_SHADED_LEVELS);

    // Naměřená vada z 24. 8. 2026: Hutě měly zem a bloky 17 bodů jasu od sebe a
    // Háj 38, takže obojí se četlo jako jedna plocha. Tahle aserce je ta podlaha —
    // a je to ona, kdo chytil, že první oprava Háje mířila podle podílu vrcholů
    // na kmeny místo na porost, který zabírá plochu.
    const separation = Math.abs(measured.groundLuminance - measured.figureLuminance);
    expect(
      separation,
      `${family.id}: zem (jas ${measured.groundLuminance.toFixed(0)}) a to, co na ní stojí ` +
        `(jas ${measured.figureLuminance.toFixed(0)}), jsou od sebe jen ${separation.toFixed(0)} bodů`,
    ).toBeGreaterThanOrEqual(MIN_FIGURE_GROUND_SEPARATION);
  }
});

/**
 * Oracle úlohy T25 — **studený návštěvník vidí, co má udělat, bez rolování**.
 *
 * Ptá se DOM pořadí, ne zdrojáku: „první interaktivní prvek" je to, na co
 * padne tabulátor jako na první, a to se z JSX odvodit nedá, protože o pořadí
 * rozhoduje složené rozvržení. Proto se seznam bere ze stránky.
 *
 * Aserce o viewportu je celá pointa slova **studený**: pole, ke kterému se musí
 * rolovat, na první obrazovce neexistuje.
 */
test('první interaktivní prvek nese instrukci a je vidět bez rolování', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/');
  await expect(page.getByTestId('first-run')).toBeVisible();

  const first = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const element = candidates[0];
    if (element === undefined) return null;
    return {
      testId: element.dataset.testid ?? null,
      label: element.getAttribute('aria-label') ?? '',
      placeholder: element.getAttribute('placeholder') ?? '',
      disabled: (element as HTMLInputElement).disabled === true,
    };
  });

  expect(first, 'stránka nemá jediný interaktivní prvek').not.toBeNull();
  expect(
    first!.testId,
    'prvním ovládacím prvkem musí zůstat vstup pro větu — nic ho nesmí předběhnout',
  ).toBe('prompt-input');
  expect(first!.disabled, 'první prvek stránky nesmí být vypnutý').toBe(false);

  // Instrukce, ne jen jmenovka. Krátký štítek typu „Věta" projde jako popisek a
  // přitom neřekne, co se má napsat — proto se měří i délka.
  const instruction = `${first!.label} ${first!.placeholder}`.trim();
  expect(instruction.length, `vstup nenese instrukci, jen: „${instruction}"`).toBeGreaterThan(40);
  expect(
    first!.placeholder.length,
    'instrukce musí být vidět na prvku, ne jen v přístupnostním stromu',
  ).toBeGreaterThan(40);

  // Bez rolování: prvek celý uvnitř okna a stránka se nikam neroluje.
  const box = (await page.getByTestId('prompt-input').boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.y, 'vstup začíná nad horní hranou okna').toBeGreaterThanOrEqual(0);
  expect(box.x, 'vstup začíná vlevo od okna').toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, 'na vstup je vidět až po odrolování dolů').toBeLessThanOrEqual(view.height);
  expect(box.x + box.width, 'vstup přetéká za pravou hranu okna').toBeLessThanOrEqual(view.width);

  const scroll = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(scroll.vertical, 'první obrazovka se roluje svisle').toBeLessThanOrEqual(0);
  expect(scroll.horizontal, 'první obrazovka se roluje vodorovně').toBeLessThanOrEqual(0);

  // Nápověda pro studeného návštěvníka musí být taky na první obrazovce.
  const hint = (await page.getByTestId('first-run').boundingBox())!;
  expect(hint.y, 'nápověda začíná nad oknem').toBeGreaterThanOrEqual(0);
  expect(hint.y + hint.height, 'nápověda je celá vidět až po odrolování').toBeLessThanOrEqual(view.height);
  await expect(page.getByTestId('first-run-example').first()).toBeVisible();
});
