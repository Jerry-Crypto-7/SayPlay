import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import disclosure from '../disclosure.json';
import sentences from '../evals/play/p32/sentences.json';
import type { GenreId } from '../src/play/genre/contract';
import { heroChoice, type ModelChoice } from '../src/play/arcade/models';

/**
 * Galerie hrdinů devíti vět P32 (P32C T5): každý hrdina a nepřítel sady
 * `evals/play/p32/sentences.json` ve stojce a v běhu proti neutrálnímu pozadí.
 * Snímky a `README.md` (úroveň výběru, zdroj, klipy, měření) jdou do
 * `evals/play/p32/heroes/` jako podklad pro autora a astru (O10).
 *
 * Scéna je vlastní a malá, bez aplikace: three.js z `node_modules`, GLB
 * z `public/` přes `page.route` na smyšlené adrese. Model se staví jako ve hře –
 * postava s klipy tak, jak ji postavil `scripts/assets/rigged/build.mjs`
 * (podstava na y = 0), statický model spodkem na zem jako `FittedModel` – a
 * otočí se tak, aby osa `forward` z manifestu mířila ke kameře. Kamera je
 * ortografická a vodorovná: zem y = 0 je na snímku přímka, takže spodní hranu
 * siluety jde porovnat na pixel.
 *
 * Test ověří ve stojce, že postava stojí na zemi (spodní hrana ±3 px; sonda
 * natočení `facing` se jen zapisuje, viz `HOVERS` a poznámku u ní);
 * v obou stavech, že zabírá aspoň 20 % výšky snímku. Běh hraje klip `run`,
 * když ho model má, jinak poskok jako `proceduralPose` v `RiggedModel.tsx`.
 */

const OUT = join(process.cwd(), 'evals', 'play', 'p32', 'heroes');
const ORIGIN = 'http://heroes.local';
const SIZE = 480;
const GROUND_TOLERANCE_PX = 3;
const MIN_HEIGHT = 0.2;
/**
 * Sonda natočení se jen zapisuje, nerozhoduje: 30. 9. dala rytíři −0,46, a na
 * snímku stojí jasně čelem (plášť a zbraně táhnou průměr dozadu). Natočení se
 * zatím soudí okem ze snímků.
 */
/** Duch z Kenney Graveyard Kit se ve svém klipu `idle` vznáší ~5 px nad zemí – schválně. */
const HOVERS: ReadonlySet<string> = new Set(['ghost']);

/** Ovládání, na které žánr (a režim) hru překládá – jako v `hero-choice.test.ts`. */
const CONTROL: Readonly<Record<string, string>> = {
  runner: 'runner',
  'quest.spatial': 'move_free',
  'quest.station': 'move_free',
  'voyage.race': 'steer',
  'voyage.land': 'steer',
  'arena.escape': 'move_free',
  'arena.fight': 'duel',
};

/** Nepřátelé vět: duchové (čaroděj), lední medvěd (kočka), žralok (výchozí nepřítel moře). */
const FOES = ['ghost', 'polar bear', 'shark'];

interface Subject {
  readonly label: string;
  readonly role: 'hero' | 'foe';
  readonly choice: ModelChoice;
}

const SUBJECTS: readonly Subject[] = [
  ...sentences.sentences.map((sentence) => ({
    label: sentence.hero,
    role: 'hero' as const,
    choice: heroChoice(sentence.hero, sentence.genre.split('.')[0] as GenreId, CONTROL[sentence.genre]),
  })),
  ...FOES.map((label) => ({ label, role: 'foe' as const, choice: heroChoice(label, undefined, 'move_free', 'enemy') })),
];

interface Shot {
  /** Spodní hrana siluety a přímka země, px od horního okraje. */
  readonly bottomPx: number;
  readonly groundPx: number;
  readonly heightPx: number;
  /** Posun hlavy a špiček ke kameře v poměru k hloubce modelu (kladný = čelem). */
  readonly facing: number;
}

const TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.html': 'text/html' };

const HARNESS = `<!doctype html><html><body style="margin:0;background:#9ca3af">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const SIZE = ${SIZE};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
document.body.appendChild(renderer.domElement);
const mask = new THREE.WebGLRenderTarget(SIZE, SIZE);
const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const loader = new GLTFLoader();
const TURN = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 };

/** Vrcholy všech sítí ve světě, se skinem v aktuální póze. */
function vertices(root) {
  const points = [];
  const v = new THREE.Vector3();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      if (object.isSkinnedMesh) object.getVertexPosition(i, v);
      else v.fromBufferAttribute(position, i);
      points.push(v.clone().applyMatrix4(object.matrixWorld));
    }
  });
  return points;
}

window.shoot = async ({ file, rigged, clip, time, bob, forward }) => {
  const gltf = await loader.loadAsync(file);
  const model = rigged ? clone(gltf.scene) : gltf.scene;
  const holder = new THREE.Group();
  holder.add(model);
  holder.rotation.y = TURN[forward];
  const scene = new THREE.Scene();
  scene.add(holder);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 4, 6);
  scene.add(sun);
  if (clip !== null) {
    const source = gltf.animations.find((animation) => animation.name === clip);
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(source).play();
    mixer.update(Math.min(time, source.duration * 0.999));
  }
  holder.updateMatrixWorld(true);
  // Statický model stojí spodkem na zemi jako FittedModel; postava s klipy stojí tak, jak ji postavil build.
  if (!rigged) {
    const rest = new THREE.Box3().setFromObject(holder, true);
    model.position.y -= rest.min.y;
    holder.updateMatrixWorld(true);
  }
  const height = new THREE.Box3().setFromObject(holder, true).getSize(new THREE.Vector3()).y;
  holder.position.y += bob * height;
  holder.updateMatrixWorld(true);

  const points = vertices(holder);
  const box = new THREE.Box3().setFromPoints(points);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Hlava (horních 30 %) a špičky (spodních 12 %) vyčnívají u postav i zvířat dopředu.
  const band = (low, high) => points.filter((p) => p.y >= box.min.y + low * size.y && p.y <= box.min.y + high * size.y);
  const meanZ = (list) => (list.length === 0 ? center.z : list.reduce((sum, p) => sum + p.z, 0) / list.length);
  const facing = (meanZ(band(0.7, 1)) + meanZ(band(0, 0.12)) - 2 * center.z) / Math.max(size.z, 1e-6);

  const low = Math.min(0, box.min.y);
  const span = Math.max(size.x, box.max.y - low) * 1.2;
  const middle = (low + box.max.y) / 2;
  const camera = new THREE.OrthographicCamera(center.x - span / 2, center.x + span / 2, middle + span / 2, middle - span / 2, 0.01, 100);
  // Kamera v x = y = 0 hledí po −z: meze snímku jsou rovnou světové x a y.
  camera.position.set(0, 0, box.max.z + 10);
  camera.lookAt(0, 0, box.max.z);
  camera.updateMatrixWorld(true);

  scene.background = new THREE.Color(0x000000);
  scene.overrideMaterial = white;
  renderer.setRenderTarget(mask);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(mask, 0, 0, SIZE, SIZE, pixels);
  renderer.setRenderTarget(null);
  let lowest = SIZE;
  let highest = -1;
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (pixels[(row * SIZE + col) * 4] > 127) {
        lowest = Math.min(lowest, row);
        highest = Math.max(highest, row);
        break;
      }
    }
  }
  scene.overrideMaterial = null;
  scene.background = new THREE.Color(0x9ca3af);
  renderer.render(scene, camera);
  const top = middle + span / 2;
  return {
    bottomPx: SIZE - lowest,
    groundPx: (top / span) * SIZE,
    heightPx: highest < 0 ? 0 : highest - lowest + 1,
    facing,
  };
};
window.harnessReady = true;
</script></body></html>`;

async function openHarness(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: HARNESS });
    const file = path.startsWith('/three/') ? join(process.cwd(), 'node_modules', path.slice(1)) : join(process.cwd(), 'public', path.slice(1));
    try {
      return await route.fulfill({ contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    } catch {
      return route.fulfill({ status: 404, body: `missing ${path}` });
    }
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { harnessReady?: boolean }).harnessReady === true);
}

const slug = (label: string): string => label.replace(/\s+/g, '-');

/** Klip stavu z manifestu, nebo `null`, když ho model nemá a pohyb dopočítá kód. */
const clipOf = (choice: ModelChoice, state: 'idle' | 'run'): string | null => {
  const clip = choice.entry?.clips[state];
  return clip === undefined || clip === 'procedural' ? null : clip;
};

const LICENSE = new Map(disclosure.entries.map((entry) => [entry.name, entry]));

test.describe('hero gallery of the P32 sentences', () => {
  test.setTimeout(180_000);

  test('every hero and foe stands on the ground, faces the camera and fills the frame', async ({ page }) => {
    await page.setViewportSize({ width: SIZE, height: SIZE });
    mkdirSync(OUT, { recursive: true });
    await openHarness(page);
    const rows: string[] = [];
    for (const subject of SUBJECTS) {
      const { choice } = subject;
      expect(choice.entry, `${subject.label}: ${choice.model} has no manifest entry`).toBeDefined();
      const entry = choice.entry!;
      const rigged = choice.model.startsWith('rigged:');
      const measured: Record<string, Shot> = {};
      for (const state of ['idle', 'run'] as const) {
        const clip = clipOf(choice, state);
        // Běh bez klipu: poskok `proceduralPose` (5 % výšky × |sin(12 t)|) v t = 0,1 s.
        const bob = state === 'run' && clip === null ? 0.05 * Math.abs(Math.sin(1.2)) : 0;
        const shot = await page.evaluate(
          (input) => (window as unknown as { shoot: (i: typeof input) => Promise<Shot> }).shoot(input),
          { file: entry.file, rigged, clip, time: state === 'idle' ? 0.5 : 0.3, bob, forward: entry.forward },
        );
        await page.screenshot({ path: join(OUT, `${slug(subject.label)}-${state}.png`) });
        measured[state] = shot;
        expect.soft(shot.heightPx / SIZE, `${subject.label} ${state}: ${shot.heightPx} px of ${SIZE}`).toBeGreaterThanOrEqual(MIN_HEIGHT);
      }
      const idle = measured.idle!;
      if (!HOVERS.has(subject.label)) expect.soft(Math.abs(idle.bottomPx - idle.groundPx), `${subject.label}: bottom ${idle.bottomPx.toFixed(1)} px, ground ${idle.groundPx.toFixed(1)} px`).toBeLessThanOrEqual(GROUND_TOLERANCE_PX);
      const license = LICENSE.get(`public${entry.file}`);
      const clips = (['idle', 'run', 'jump', 'hit', 'die'] as const).map((state) => `${state} ${entry.clips[state] === 'procedural' ? '–' : `\`${entry.clips[state]}\``}`).join(', ');
      rows.push(
        `| ${subject.label} | ${subject.role === 'hero' ? 'hrdina' : 'nepřítel'} | \`${choice.model}\` | ${choice.level} | ${license?.authorOrProvider ?? '?'}, ${license?.license ?? entry.license} – ${license?.source ?? entry.file} | ${clips} | ${Math.abs(idle.bottomPx - idle.groundPx).toFixed(1)} px | ${idle.facing.toFixed(2)} | ${((idle.heightPx / SIZE) * 100).toFixed(0)} % / ${((measured.run!.heightPx / SIZE) * 100).toFixed(0)} % | ![stojka](${slug(subject.label)}-idle.png) ![běh](${slug(subject.label)}-run.png) |`,
      );
    }
    writeFileSync(
      join(OUT, 'README.md'),
      [
        '# Galerie hrdinů vět P32 (P32C T5)',
        '',
        'Generuje `e2e/p32-heroes.spec.ts` – needitovat ručně. Hrdina a nepřítel každé z devíti vět `evals/play/p32/sentences.json` ve stojce a v běhu, ortografická kamera zepředu, osa `forward` z manifestu míří ke kameře. Běh bez klipu je poskok jako `proceduralPose` v `RiggedModel.tsx`.',
        '',
        '- **Úroveň:** `identity` = model, který větu jmenuje; `near` = blízká identita; `class` = zástupce třídy; `fallback` = výchozí model role (`heroChoice` v `src/play/arcade/models.ts`).',
        '- **Klipy:** jméno klipu v GLB, `–` = pohyb dopočítá kód.',
        `- **Země:** rozdíl spodní hrany siluety a země ve stojce (limit ${GROUND_TOLERANCE_PX} px). **Čelem:** sonda natočení – o kolik hlava a špičky vyčnívají ke kameře v poměru k hloubce modelu; kladná = čelem; jen se zapisuje, rytíři čelem dala −0,46, natočení soudí oko. **Výška:** podíl výšky snímku ve stojce / v běhu (limit ${MIN_HEIGHT * 100} %).`,
        '- Kuchař a žralok zatím nemají animovaný model: `evals/play/p32/kits-missing.md`.',
        '',
        '| Věta | Role | Model | Úroveň | Zdroj | Klipy | Země | Čelem | Výška | Snímky |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
      ].join('\n'),
    );
  });
});
