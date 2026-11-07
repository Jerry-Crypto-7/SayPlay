#!/usr/bin/env node
/**
 * P75 T3: malovaná obloha venkovních míst ve stylu konceptu A (hračkové diorama, zlatá hodina).
 * FLUX.2-klein-4B lokálně přes ComfyUI (`D:/tools/comfyui`, port 8188), 0 USD.
 *
 *   node scripts/play/p75-bake.mjs [--only volcano,city] [--force]   # vygeneruje a zakóduje
 *   node scripts/play/p75-bake.mjs --register                         # zapíše záznamy do disclosure.json
 *
 * Panorama se generuje o `BAND` px širší a pravý přesah se prolne přes levý okraj (šev jako
 * `ops/env/seam.py`). Výstup `public/play/env/diorama-<místo>.webp` 2048×1024 ≤ 300 kB
 * a `-low.webp` 1024×512 pro telefon. Hotové místo se nepřegeneruje bez `--force`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { args } from '../play-look-shots.mjs';
import { run, waitComfy } from './p75-restyle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'public', 'play', 'env');
const RAW = join(tmpdir(), 'p75-bake');
const WIDTH = 2048;
const HEIGHT = 1024;
const BAND = 256;
const LOW = { width: 1024, height: 512 };
const MAX_BYTES = 300_000;
const MAX_LOW_BYTES = 60_000;
const SEED = 75;

/** Horizont každého venkovního místa `LOOKS`; pořadí = nejdřív místa 12 vět P73D. */
export const PLACES = {
  volcano: 'a volcanic land, a big smoking volcano cone on the horizon with a soft orange lava glow, warm brown rounded rocky hills, peach and orange sunset sky with soft smoke clouds',
  underwater: 'a coral reef seen from the sandy sea floor, rounded coral arches and pink, orange and yellow corals on the horizon, soft sun rays from the bright turquoise water surface above, gentle blue-green haze',
  city: 'a toy town, a skyline of rounded colourful toy buildings, chimneys and water towers on the horizon, warm golden evening sky with soft fluffy clouds',
  castle: 'a fairy-tale land, an old stone castle with round towers and red flags on a green hill on the horizon, rolling green hills, warm golden sky with fluffy clouds',
  beach: 'a sunny tropical beach, calm turquoise sea, small green islands with palm trees on the horizon, warm golden sky with fluffy clouds',
  space: 'deep space seen from a small rocky moon, a big ringed planet and a colourful teal and orange nebula in a starry sky, rounded orange craters on the horizon',
  meadow: 'green rolling meadow hills with flowers and round trees, a windmill on a hill, warm golden-hour sky with soft fluffy clouds',
  snow: 'snowy mountains, rounded snow-capped peaks and snowy pine trees on the horizon, warm pink and gold sunset sky',
  forest: 'a green forest, rounded tree crowns and pine trees on soft hills on the horizon, warm golden light, soft haze',
  jungle: 'a lush jungle, rounded green jungle hills, palm trees and a waterfall on the horizon, warm golden haze',
  desert: 'a sunny desert, rounded orange mesas and sand dunes on the horizon, warm golden sky',
  ocean: 'open sea with calm waves, a lighthouse on a small rocky island on the horizon, warm golden sky with fluffy clouds',
  graveyard: 'a spooky hill at night, a ruined castle on the horizon, dark blue night sky with a big round moon, soft teal mist, moonlight instead of sunset',
};

const STYLE = 'stylized toy diorama world, warm golden-hour light, soft hazy atmosphere, chunky rounded toy shapes, saturated but soft colours, painted video game backdrop';
const FRAME = 'horizon line exactly at the vertical center, open sky in the upper half, ground in the lower half, no people, no characters, no text, no frame, no border';
export const prompt = (place) => `360 degree equirectangular panorama of ${PLACES[place]}. ${STYLE}. ${FRAME}`;

function workflow(text, seed) {
  const size = { width: WIDTH + BAND, height: HEIGHT };
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-4b.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'flux2', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    prompt: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['prompt', 0] } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['unet', 0], positive: ['prompt', 0], negative: ['negative', 0], cfg: 1 } },
    select: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sigmas: { class_type: 'Flux2Scheduler', inputs: { steps: 4, ...size } },
    latent: { class_type: 'EmptyFlux2LatentImage', inputs: { ...size, batch_size: 1 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    sampler: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['select', 0], sigmas: ['sigmas', 0], latent_image: ['latent', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'p75/diorama' } },
  };
}

/** Obraz šířky W + BAND → W, okraje navazují dokola (`ops/env/seam.py` `seam_blend`). */
async function seamless(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const keep = width - BAND;
  const out = Buffer.alloc(keep * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < keep; x += 1) {
      const t = x < BAND ? x / BAND : 1;
      for (let c = 0; c < channels; c += 1) {
        const own = data[(y * width + x) * channels + c];
        const wrap = x < BAND ? data[(y * width + keep + x) * channels + c] : own;
        out[(y * keep + x) * channels + c] = Math.round(own * t + wrap * (1 - t));
      }
    }
  }
  return sharp(out, { raw: { width: keep, height, channels } });
}

/** Nejvyšší kvalita WebP, která se vejde do limitu (`ops/env/panorama.py` `encode`). */
async function encode(image, limit) {
  for (let quality = 88; quality > 20; quality -= 6) {
    const bytes = await image.clone().webp({ quality, effort: 6 }).toBuffer();
    if (bytes.length <= limit) return bytes;
  }
  throw new Error(`cannot fit into ${limit} bytes`);
}

const PAINTED = {
  kind: 'asset',
  firstParty: true,
  reason: 'Painted diorama sky for an outdoor place, generated locally with FLUX.2 klein 4B (Apache-2.0) through ComfyUI from a place prompt; seam blended and encoded by scripts/play/p75-bake.mjs.',
  source: 'scripts/play/p75-bake.mjs',
  authorOrProvider: 'Worldsmith project – generated by scripts/play/p75-bake.mjs',
  license: 'LicenseRef-Worldsmith-Generated',
  requiredNotices: ["No third-party asset notice; generated by the project's own pipeline. Prompts in scripts/play/p75-bake.mjs."],
  attribution: 'Worldsmith painted diorama skies (FLUX.2 [klein] 4B © Black Forest Labs, Apache-2.0), 2026-11-07.',
  reviewNote: 'First-party output of a local generation model whose licence is registered in disclosure.json (FLUX.2-klein-4B); no downloaded image or texture.',
  scope: 'prod',
};

function register() {
  const file = join(ROOT, 'disclosure.json');
  const disclosure = JSON.parse(readFileSync(file, 'utf8'));
  for (const place of Object.keys(PLACES)) {
    for (const suffix of ['', '-low']) {
      const name = `public/play/env/diorama-${place}${suffix}.webp`;
      if (!existsSync(join(ROOT, name))) continue;
      const record = { name, ...PAINTED };
      const index = disclosure.entries.findIndex((entry) => entry.kind === 'asset' && entry.name === name);
      if (index < 0) disclosure.entries.push(record);
      else disclosure.entries[index] = record;
    }
  }
  writeFileSync(file, `${JSON.stringify(disclosure, null, 2)}\n`);
}

async function main() {
  const options = args();
  if (options.register === true) return register();
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  mkdirSync(RAW, { recursive: true });
  await waitComfy();
  for (const place of Object.keys(PLACES)) {
    if (only !== null && !only.has(place)) continue;
    const full = join(OUT, `diorama-${place}.webp`);
    if (existsSync(full) && options.force !== true) continue;
    const started = Date.now();
    const png = await run(workflow(prompt(place), SEED));
    writeFileSync(join(RAW, `${place}.png`), png);
    const image = await seamless(png);
    const bytes = await encode(image, MAX_BYTES);
    const low = await encode(image.clone().resize(LOW.width, LOW.height, { kernel: 'lanczos3' }), MAX_LOW_BYTES);
    writeFileSync(full, bytes);
    writeFileSync(join(OUT, `diorama-${place}-low.webp`), low);
    console.log(place, Date.now() - started, 'ms', bytes.length, 'B', low.length, 'B');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
