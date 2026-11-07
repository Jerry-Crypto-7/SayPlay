#!/usr/bin/env node
/**
 * P75 T1 koncept A: náš snímek hry → FLUX.2-klein-4B edit (ReferenceLatent) ve stylu hračkového diorama.
 * Lokálně přes ComfyUI (`D:/tools/comfyui`, port 8188), 0 USD. Kopie `restyle.mjs` ze sezení 24a74f3a
 * (koncepty P73D), zúžená na styl A a 12 vět P73D.
 *
 *   node scripts/play/p75-restyle.mjs [--only s5,s6] [--from evals/play/p73/sceny/after] [--moment 1play] [--force]
 *
 * Vstup `<from>/<věta>-desktop-<moment>.jpg` (1440×900), výstup `evals/play/p75/target/<věta>.png` (1152×640).
 * Hotový cíl se nepřepisuje bez `--force`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMFY = 'http://127.0.0.1:8188';

/** Co má koncept ukázat; s1–s4 jsou stejná zadání jako koncepty P73D (runner, race, chase, stack). */
export const SCENES = {
  s1: 'an endless runner game: a small explorer running down a path inside a volcano, glowing lava river beside the path, erupting volcano on the horizon',
  s2: 'an underwater racing game: a sea turtle racing against a shark along a coral reef race track, finish arch in the distance',
  s3: 'a chase game: a cat carrying a pizza box running across city rooftops, seagulls chasing it, chimneys and water towers, city skyline behind',
  s4: 'a stacking game: a tall wobbly tower of pancakes on a plate on a windy hill, leaves blowing, a windmill behind',
  s5: 'a platformer game: a small knight jumping across floating grassy islands above a sunny beach to reach a dragon egg on the last island, sea and palm trees below',
  s6: 'a space shooter game: a small spaceship flying through deep space shooting tumbling asteroids, a ringed planet and a nebula in the distance',
  s7: 'a mini golf game in a candy land: a golf ball on a putting green lined with lollipops, candy canes and gumdrops, the hole with a little flag ahead',
  s8: 'an adventure quest game: a small hero exploring the courtyard of an old stone castle looking for a lost golden crown, towers and banners around',
  s9: 'a flying game: a small bird gliding between tall city buildings in a stormy sky, dark rain clouds and lightning above the skyline',
  s10: 'a catching game: a farmer with a basket catching apples falling from apple trees in a sunny orchard, wooden fence and a red barn behind',
  s11: 'a racing game: a dog racing against a cat along a candy land race track lined with lollipops and candy canes, finish arch in the distance',
  s12: 'an endless runner game: a penguin sliding down an icy mountain slope, snowy pine trees beside the path, snow-capped peaks on the horizon',
};

export const STYLE_A = 'stylized toy diorama, the whole level is a small handcrafted world on a floating base, warm golden-hour light, soft shadows, tilt-shift depth of field, chunky rounded shapes, saturated but soft colours, like Captain Toad Treasure Tracker or Astro Bot';
const CAMERA = 'Three-quarter view from behind and above the hero, clear sense of depth and perspective, visible horizon line, foreground, midground and background layers. Video game screenshot, no text, no user interface.';
export const SEED = 7;

/** Výřez ze snímku 1440×900, který koncept přemaluje; soudce T1 ukazuje hru se stejným výřezem. */
export const CROP = { width: 1264, height: 704, x: 88, y: 100 };
export const SIZE = { width: 1152, height: 640 };

export async function waitComfy() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${COMFY}/system_stats`)).ok) return;
    } catch { /* ještě startuje */ }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error('comfy did not start');
}

export async function upload(file) {
  const form = new FormData();
  form.append('image', new Blob([readFileSync(file)]), basename(file));
  form.append('overwrite', 'true');
  const response = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
  return (await response.json()).name;
}

function workflow(image, text, seed) {
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-4b.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'flux2', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    load: { class_type: 'LoadImage', inputs: { image } },
    crop: { class_type: 'ImageCrop', inputs: { image: ['load', 0], ...CROP } },
    scale: { class_type: 'ImageScale', inputs: { image: ['crop', 0], upscale_method: 'lanczos', ...SIZE, crop: 'center' } },
    enc: { class_type: 'VAEEncode', inputs: { pixels: ['scale', 0], vae: ['vae', 0] } },
    prompt: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text } },
    ref: { class_type: 'ReferenceLatent', inputs: { conditioning: ['prompt', 0], latent: ['enc', 0] } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['prompt', 0] } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['unet', 0], positive: ['ref', 0], negative: ['negative', 0], cfg: 1 } },
    select: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sigmas: { class_type: 'Flux2Scheduler', inputs: { steps: 4, ...SIZE } },
    latent: { class_type: 'EmptyFlux2LatentImage', inputs: { ...SIZE, batch_size: 1 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    sampler: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['select', 0], sigmas: ['sigmas', 0], latent_image: ['latent', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'p75/target' } },
  };
}

/** Pošle workflow a počká na první uložený obrázek (uzel `save`). */
export async function run(graph) {
  const response = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) });
  const queued = await response.json();
  if (!queued.prompt_id) throw new Error(JSON.stringify(queued).slice(0, 600));
  for (;;) {
    await new Promise((done) => setTimeout(done, 1500));
    const history = await (await fetch(`${COMFY}/history/${queued.prompt_id}`)).json();
    const entry = history[queued.prompt_id];
    if (entry?.status?.status_str === 'error') throw new Error(JSON.stringify(entry.status).slice(0, 600));
    const image = entry?.outputs?.save?.images?.[0];
    if (image) {
      const url = `${COMFY}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=output`;
      return Buffer.from(await (await fetch(url)).arrayBuffer());
    }
  }
}

export const prompt = (id) => `Redraw this game scene as ${SCENES[id]}. Style: ${STYLE_A}. ${CAMERA}`;

async function main() {
  const options = args();
  const from = resolve(ROOT, typeof options.from === 'string' ? options.from : 'evals/play/p73/sceny/after');
  const moment = typeof options.moment === 'string' ? options.moment : '1play';
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const out = join(ROOT, 'evals', 'play', 'p75', 'target');
  mkdirSync(out, { recursive: true });
  await waitComfy();
  for (const id of Object.keys(SCENES)) {
    if (only !== null && !only.has(id)) continue;
    const target = join(out, `${id}.png`);
    if (existsSync(target) && options.force !== true) continue;
    const name = await upload(join(from, `${id}-desktop-${moment}.jpg`));
    const started = Date.now();
    writeFileSync(target, await run(workflow(name, prompt(id), SEED)));
    console.log(id, Date.now() - started, 'ms');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
