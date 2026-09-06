import { expect, test } from '@playwright/test';
import { ACESFilmicToneMapping, Matrix4, PCFSoftShadowMap, PerspectiveCamera, Vector3 } from 'three';

import { compileGeomProgram } from '../src/geom/compile';
import { FAMILIES } from '../src/geom/families';
import { GEOM_VERSION, type GeomProgram } from '../src/geom/program';
import { KIT_BUDGETS, VIEWER_BUDGETS, trianglesOf } from '../src/kit/budgets';
import { MIN_FIGURE_GROUND_SEPARATION, PALETTES, repaint } from '../src/kit/palettes';
import { FOG, KEY_LIGHT, SHADOW_MAP_TYPE, TOON_LEVELS } from '../src/components/viewer/Lighting';
import { layoutById } from '../src/kit';
import { deriveLook } from '../src/worldstream/look';
import { repairLook } from '../src/worldstream/look-repair';

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
  // **Do P14 T3 tady stála barva stránky (`FOG.color`).** Plátno bylo
  // průhledné a vzdálený kus mizel do stránky. Od T3 je za scénou obloha, takže
  // mlha musí končit v obzoru — a bere si proto barvu z popisu vzhledu, stejně
  // jako obzor samotný. Dvě různé barvy by na obzoru udělaly viditelnou hranu.
  //
  // Pin je odvozená barva, ne konstanta: kdyby se prohlížeč vrátil k pevné
  // hodnotě nebo popis vzhledu obešel, tahle aserce zčervená. Barva mlhy závisí
  // jen na paletě, ne na semínku, takže se smí odvodit s libovolným.
  //
  // **Od P14 T11 se odvozený vzhled porovnává až po podlaze** (`repairLook`).
  // Scéna kreslí opravený popis, takže porovnání se syrovým `deriveLook` by
  // tvrdilo vadu tam, kde je oprava — naměřeno 29. 8. 2026: mlha `#504a39`
  // proti odvozené `#394a50`. Řetěz zůstává celý: pin pořád drží, že barva
  // mlhy vzniká z popisu vzhledu, jen se ptá té jeho podoby, která jde na plátno.
  const derived = repairLook(
    deriveLook({
      palette: layoutById('harbor-pier')!.palette,
      terrain: 'flat',
      seed: 1,
    }),
  ).look;
  expect(stats.fog!.color, 'mlha má barvu obzoru z popisu vzhledu, ne barvu stránky').toBe(
    derived.fog.color,
  );
  expect(stats.fog!.color, 'barva stránky je přesně to, co T3 opustila').not.toBe(FOG.color);
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

/**
 * Podlaha podílu plochy, kterou zabírá **postavený obsah** — všechno kromě zemi.
 *
 * Naměřená vada z 24. 8. 2026: zem zabírala 65 až 91 % snímku a to, co na ní
 * stálo, 1 až 9 %. Rodiny se četly jako prázdná placka, protože deska terénu
 * přebila všechno ostatní.
 *
 * **Neměří se „druhá nejčastější barva", i když tak zní zadání úlohy.** Ta
 * metrika má naměřenou díru: u Háje je druhá nejčastější barva pořád zem (dva
 * stupně téže zelené), takže by ji šlo splnit dvoubarevným terénem a obrázek
 * by se nezměnil. Měří se proto plocha, která **není žádná z barev terénu** —
 * a barvy terénu se berou z druhého kreslení téhož programu bez všeho, co na
 * něm stojí. Nic se neodhaduje: je to týž shader a týž pixel.
 *
 * Kus figury, který má barvu zemi, se počítá jako zem. Podlaha je tím přísnější,
 * ne shovívavější — a odpovídá tomu, co oko vidí: co má barvu podkladu, na
 * podkladu není vidět.
 */
const MIN_FIGURE_AREA_SHARE = 0.15;

/**
 * Strop téhož podílu. Svět musí stát na zemi, kterou je vidět — a měření, které
 * by za figuru označilo celý snímek, by podlahu výš splnilo, aniž by o obrázku
 * cokoli tvrdilo. Tohle je ta druhá strana: podlaha hlídá scénu, strop hlídá
 * měření.
 */
const MAX_FIGURE_AREA_SHARE = 0.9;

/**
 * Kolik stupňů musí rampa přes snímek najít.
 *
 * Měří se **poměr stínovaného jasu k plochému na témž pixelu**, ne počet jasů ve
 * stínovaném snímku. To je rozdíl mezi asercí, která něco tvrdí, a asercí, která
 * projde vždycky: různých jasů má snímek spoustu i s mrtvou rampou, protože je
 * v něm víc odstínů. Poměr odstín vykrátí a zbude z něj čistě stupeň rampy.
 */
const MIN_RAMP_STEPS = 2;

interface FamilyFrame {
  /** Podíl plochy, na které je vidět svět. */
  readonly coverage: number;
  /** Kolik různých stupňů rampy je přes snímek vidět. */
  readonly rampSteps: number;
  /** Jas nejčastější barvy plochého snímku. To je zem. */
  readonly groundLuminance: number;
  /** Jas druhé nejčastější. To je, co na zemi stojí. */
  readonly figureLuminance: number;
  /** Podíl osvětlené plochy, který nemá žádnou z barev terénu. */
  readonly figureShare: number;
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
  // Podíl figury se sbírá a soudí až za smyčkou, aby jeden běh vydal všechny
  // čtyři rodiny. Aserce uvnitř zastaví na první a o zbylých třech neřekne nic,
  // což je u čísla, které se ladí kompozicí, ten dražší způsob měření.
  const shares: { id: string; share: number }[] = [];

  for (const family of FAMILIES) {
    const program = family.compose(FAMILY_SEED);
    const geometry = compileGeomProgram(program);
    repaint(geometry, PALETTES[family.palette]);

    // Týž program bez všeho, co na zemi stojí. Slouží k jedinému: říct, které
    // barvy na snímku JSOU zem. Odvodit je z palety nejde — shader píše pixel
    // přes vlastní gamma korekci, takže bajt v obrázku se s hexem palety
    // nerovná a porovnání by tiše selhalo na zaokrouhlení.
    const terrain = program.nodes.find((node) => node.kind === 'terrain');
    expect(terrain, `${family.id} nemá terén — bez něj se zem od figury neodliší`).toBeDefined();
    const groundOnly: GeomProgram = { version: GEOM_VERSION, nodes: [terrain!], root: 0 };
    const groundGeometry = compileGeomProgram(groundOnly);
    repaint(groundGeometry, PALETTES[family.palette]);

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

    const pack = (source: typeof geometry) => {
      const base64 = (name: string) =>
        Buffer.from((source.getAttribute(name).array as Float32Array).buffer).toString('base64');
      return {
        position: base64('position'),
        color: base64('color'),
        normal: base64('normal'),
        vertices: source.getAttribute('position').count,
      };
    };
    const packed = pack(geometry);
    const packedGround = pack(groundGeometry);
    geometry.dispose();
    groundGeometry.dispose();

    const measured = await page.evaluate(
      async ({
        packed,
        packedGround,
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

        const upload = (source: typeof packed): void => {
          for (const [name, value] of [
            ['aPosition', source.position],
            ['aColor', source.color],
            ['aNormal', source.normal],
          ] as const) {
            const location = gl.getAttribLocation(program, name);
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, decode(value), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
          }
        };
        upload(packed);

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
        const draw = (shade: number, vertices: number): Uint8Array => {
          gl.uniform1f(shadeAt, shade);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, vertices);
          const pixels = new Uint8Array(size * size * 4);
          gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };

        const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

        const shaded = draw(1, packed.vertices);
        let lit = 0;
        for (let index = 0; index < size * size; index += 1) {
          if (shaded[index * 4 + 3] !== 0) lit += 1;
        }

        const flat = draw(0, packed.vertices);

        // Stupeň rampy = poměr stínovaného jasu k plochému na témž pixelu.
        // Odstín se vykrátí, takže zbude jen to, co udělalo světlo.
        const rampSteps = new Set<number>();
        for (let index = 0; index < size * size; index += 1) {
          if (shaded[index * 4 + 3] === 0) continue;
          const flatLuminance = luminance(flat[index * 4], flat[index * 4 + 1], flat[index * 4 + 2]);
          if (flatLuminance < 1) continue;
          const shadedLuminance = luminance(
            shaded[index * 4],
            shaded[index * 4 + 1],
            shaded[index * 4 + 2],
          );
          rampSteps.add(Math.round((shadedLuminance / flatLuminance) * 20) / 20);
        }
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

        // Druhé kreslení: jenom zem, táž kamera, týž shader. Barvy, které se
        // v něm objeví, jsou zem — a všechno ostatní ve snímku výš je figura.
        const keyAt = (pixels: Uint8Array, index: number) =>
          `${pixels[index * 4]},${pixels[index * 4 + 1]},${pixels[index * 4 + 2]}`;

        upload(packedGround);
        const groundFrame = draw(0, packedGround.vertices);
        const groundColors = new Set<string>();
        for (let index = 0; index < size * size; index += 1) {
          if (groundFrame[index * 4 + 3] !== 0) groundColors.add(keyAt(groundFrame, index));
        }

        let figure = 0;
        for (let index = 0; index < size * size; index += 1) {
          if (flat[index * 4 + 3] === 0) continue;
          if (!groundColors.has(keyAt(flat, index))) figure += 1;
        }

        return {
          coverage: lit / (size * size),
          rampSteps: rampSteps.size,
          groundLuminance: ranked.length > 0 ? luminanceOfKey(ranked[0][0]) : 0,
          figureLuminance: ranked.length > 1 ? luminanceOfKey(ranked[1][0]) : 0,
          figureShare: lit > 0 ? figure / lit : 0,
        };
      },
      {
        packed,
        packedGround,
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

    // Rampa se stejnými stupni vydá jediný poměr, tedy plochý svět bez světla.
    expect(
      measured.rampSteps,
      `${family.id} je nasvícený naplocho — rampa nerozlomila povrch na stupně`,
    ).toBeGreaterThanOrEqual(MIN_RAMP_STEPS);

    // Naměřená vada z 24. 8. 2026: Hutě měly zem a bloky 17 bodů jasu od sebe a
    // Háj 38, takže obojí se četlo jako jedna plocha. Tahle aserce je ta podlaha —
    // a je to ona, kdo chytil, že první oprava Háje mířila podle podílu vrcholů
    // na kmeny místo na porost, který zabírá plochu.
    shares.push({ id: family.id, share: measured.figureShare });

    const separation = Math.abs(measured.groundLuminance - measured.figureLuminance);
    expect(
      separation,
      `${family.id}: zem (jas ${measured.groundLuminance.toFixed(0)}) a to, co na ní stojí ` +
        `(jas ${measured.figureLuminance.toFixed(0)}), jsou od sebe jen ${separation.toFixed(0)} bodů`,
    ).toBeGreaterThanOrEqual(MIN_FIGURE_GROUND_SEPARATION);
  }

  // Naměřená vada z 24. 8. 2026: zem 65 až 91 % snímku, postavený obsah 1 až 9 %.
  const report = shares.map((entry) => `${entry.id} ${(entry.share * 100).toFixed(1)} %`).join(', ');
  const thin = shares.filter((entry) => entry.share < MIN_FIGURE_AREA_SHARE);
  expect(
    thin.map((entry) => entry.id),
    `postavený obsah zabírá míň než ${(MIN_FIGURE_AREA_SHARE * 100).toFixed(0)} % ` +
      `osvětlené plochy — naměřeno: ${report}`,
  ).toEqual([]);

  const groundless = shares.filter((entry) => entry.share > MAX_FIGURE_AREA_SHARE);
  expect(
    groundless.map((entry) => entry.id),
    `ze snímku zmizela zem, na které svět stojí — naměřeno: ${report}`,
  ).toEqual([]);
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

  await page.goto('/classic');
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
