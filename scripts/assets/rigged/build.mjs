#!/usr/bin/env node
/**
 * Riggované postavy do hry (P26B T4).
 *
 *   node scripts/assets/rigged/build.mjs [cacheDir]
 *
 * Bere soubory stažené `fetch.mjs` (cache mimo repo, `fetched.json` drží
 * sha256) a pro každou postavu z `CHARACTERS`: nechá jen klipy namapované na
 * stavy hry (`idle|run|jump|shoot|hit|die`), vloží vnější textury do GLB,
 * zahodí data, na která už nic neukazuje, a přidá kořenový uzel, který
 * postavu postaví na podstavu (střed v ose, spodek na y = 0) a zmenší na
 * metry. Klipy se nepřevzorkují ani nekvantují – co je v souboru, hraje stejně
 * jako ve zdroji. Postava bez `idle` a `run`, nad rozpočtem trojúhelníků nebo
 * velikosti se nezařadí a důvod jde do `excluded` v manifestu.
 *
 * Píše `public/assets/worldstream/rigged/<id>.glb`, `PROVENANCE.md` vedle nich,
 * manifesty `src/assets/rigged.json` (P26B) a `src/assets/rigged-p32.json`
 * (hrdinové vět P32, `P32_CHARACTERS`) a položky těch souborů v `disclosure.json`.
 * Vnější textura větší než `MAX_TEXTURE` se při vkládání zmenší.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import validator from 'gltf-validator';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'worldstream', 'rigged');
const PUBLIC_PREFIX = '/assets/worldstream/rigged';
export const MAX_TRIANGLES = 12_500;
export const MAX_BYTES = 1.5 * 1024 * 1024;
/** Rozpočet hrdiny P32 (plán P32C): GLB do 400 KB, textury do 512 px. */
export const HERO_MAX_BYTES = 400 * 1024;
export const MAX_TEXTURE = 512;
/** Výška postavy po normalizaci (m); scéna ji stejně vepíše do kvádru těla. */
const HEIGHT_M = 1.8;
const REQUIRED = ['idle', 'run'];

const KAYKIT_BASE = { idle: 'Idle', run: 'Running_A', jump: 'Jump_Idle', shoot: '1H_Melee_Attack_Chop', hit: 'Hit_A', die: 'Death_A' };
const KAYKIT_CASTER = { ...KAYKIT_BASE, shoot: 'Spellcast_Shoot' };
const KAYKIT_ARCHER = { ...KAYKIT_BASE, shoot: '2H_Ranged_Shoot' };
const KENNEY_MINI = { idle: 'idle', run: 'sprint', jump: 'jump', shoot: 'holding-right-shoot', die: 'die' };
const UAL = { idle: 'Idle_Loop', run: 'Jog_Fwd_Loop', jump: 'Jump_Loop', shoot: 'Pistol_Shoot', hit: 'Hit_Chest', die: 'Death01' };

/**
 * Kandidáti: zdroj z `sources.json`, soubor v jeho cache, tagy rolí a mapa stavů → klip.
 * Tag je podstatné jméno, které postavu opravdu popisuje – ne činnost („runner“,
 * „hero“: „cat runner“ je kočka) a ne příbuzná příšera (kostlivec není zombie).
 */
export const CHARACTERS = [
  { id: 'knight', name: 'Knight', source: 'kaykit-adventurers', file: 'Knight.glb', tags: ['knight', 'soldier', 'warrior', 'paladin', 'guard', 'crusader'], clips: KAYKIT_BASE },
  { id: 'barbarian', name: 'Barbarian', source: 'kaykit-adventurers', file: 'Barbarian.glb', tags: ['barbarian', 'viking', 'warrior', 'brute', 'fighter', 'gladiator'], clips: KAYKIT_BASE },
  { id: 'mage', name: 'Mage', source: 'kaykit-adventurers', file: 'Mage.glb', tags: ['wizard', 'mage', 'sorcerer', 'witch', 'magician', 'warlock'], clips: KAYKIT_CASTER },
  { id: 'rogue', name: 'Rogue', source: 'kaykit-adventurers', file: 'Rogue.glb', tags: ['rogue', 'thief', 'bandit', 'assassin', 'pirate'], clips: KAYKIT_BASE },
  { id: 'rogue-hooded', name: 'Hooded Rogue', source: 'kaykit-adventurers', file: 'Rogue_Hooded.glb', tags: ['archer', 'ranger', 'hunter', 'ninja', 'hood'], clips: KAYKIT_ARCHER },
  { id: 'skeleton-warrior', name: 'Skeleton Warrior', source: 'kaykit-skeletons', file: 'Skeleton_Warrior.glb', tags: ['skeleton', 'undead', 'warrior'], clips: KAYKIT_BASE },
  { id: 'skeleton-minion', name: 'Skeleton Minion', source: 'kaykit-skeletons', file: 'Skeleton_Minion.glb', tags: ['skeleton', 'undead', 'minion'], clips: KAYKIT_BASE },
  { id: 'skeleton-mage', name: 'Skeleton Mage', source: 'kaykit-skeletons', file: 'Skeleton_Mage.glb', tags: ['skeleton', 'necromancer', 'lich', 'undead'], clips: KAYKIT_CASTER },
  { id: 'skeleton-rogue', name: 'Skeleton Rogue', source: 'kaykit-skeletons', file: 'Skeleton_Rogue.glb', tags: ['skeleton', 'undead', 'bandit'], clips: KAYKIT_BASE },
  { id: 'boy-a', name: 'Boy A', source: 'kenney-mini-characters', file: 'Models/GLB format/character-male-a.glb', tags: ['boy', 'kid', 'man', 'person', 'human'], clips: KENNEY_MINI },
  { id: 'boy-b', name: 'Boy B', source: 'kenney-mini-characters', file: 'Models/GLB format/character-male-b.glb', tags: ['boy', 'kid', 'man', 'person', 'human', 'student'], clips: KENNEY_MINI },
  { id: 'boy-c', name: 'Boy C', source: 'kenney-mini-characters', file: 'Models/GLB format/character-male-c.glb', tags: ['boy', 'kid', 'man', 'person', 'human'], clips: KENNEY_MINI },
  { id: 'girl-a', name: 'Girl A', source: 'kenney-mini-characters', file: 'Models/GLB format/character-female-a.glb', tags: ['girl', 'kid', 'woman', 'person', 'human'], clips: KENNEY_MINI },
  { id: 'girl-b', name: 'Girl B', source: 'kenney-mini-characters', file: 'Models/GLB format/character-female-b.glb', tags: ['girl', 'kid', 'woman', 'person', 'human', 'student'], clips: KENNEY_MINI },
  { id: 'girl-c', name: 'Girl C', source: 'kenney-mini-characters', file: 'Models/GLB format/character-female-c.glb', tags: ['girl', 'kid', 'woman', 'person', 'human'], clips: KENNEY_MINI },
  { id: 'mannequin', name: 'Mannequin', source: 'quaternius-ual', file: 'AnimationLibrary_Godot_Standard.gltf', tags: ['mannequin', 'dummy', 'robot', 'android'], clips: UAL },
];

/** Kenney Cube Pets: kostičková zvířata, klipy pohybují díly těla; skok, zásah ani smrt nemají. */
const CUBE_PET = { idle: 'idle', run: 'run' };
const KENNEY_CHARACTER = { idle: 'idle', run: 'sprint', jump: 'jump', die: 'die' };

/**
 * Hrdinové a nepřátelé vět P32, kteří měli jen statický model (P32C T2, `STATIC`
 * v `hero-choice.test.ts`). Id se liší od modelů katalogu (`cat`, `ghost`), ať
 * manifest drží obě položky. Kuchař a žralok nejdou stáhnout headless –
 * `evals/play/p32/kits-missing.md`.
 */
export const P32_CHARACTERS = [
  { id: 'pet-penguin', name: 'Cube Penguin', source: 'kenney-cube-pets', file: 'Models/GLB format/animal-penguin.glb', tags: ['penguin'], clips: CUBE_PET },
  { id: 'pet-cat', name: 'Cube Cat', source: 'kenney-cube-pets', file: 'Models/GLB format/animal-cat.glb', tags: ['cat', 'kitten', 'kitty'], clips: CUBE_PET },
  { id: 'pet-dog', name: 'Cube Dog', source: 'kenney-cube-pets', file: 'Models/GLB format/animal-dog.glb', tags: ['dog', 'puppy', 'pup', 'hound'], clips: CUBE_PET },
  { id: 'pet-polar-bear', name: 'Cube Polar Bear', source: 'kenney-cube-pets', file: 'Models/GLB format/animal-polar.glb', tags: ['polar-bear', 'bear'], clips: CUBE_PET },
  { id: 'graveyard-ghost', name: 'Graveyard Ghost', source: 'kenney-graveyard-kit', file: 'Models/GLB format/character-ghost.glb', tags: ['ghost', 'spirit', 'phantom', 'spook'], clips: KENNEY_CHARACTER },
  { id: 'blocky-robot', name: 'Blocky Robot', source: 'kenney-blocky-characters', file: 'Models/GLB format/character-g.glb', tags: ['robot', 'android', 'droid', 'bot'], clips: KENNEY_CHARACTER },
];

// ---------------------------------------------------------------------------
// GLB

const fail = (message) => {
  throw new Error(message);
};

/** GLB → `{ doc, bin }`; jediný binární blok. */
export function readGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) fail('not a glTF 2.0 binary');
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binAt = 20 + jsonLength;
  const bin = binAt < bytes.length ? bytes.subarray(binAt + 8, binAt + 8 + bytes.readUInt32LE(binAt)) : Buffer.alloc(0);
  return { doc, bin };
}

export function writeGlb(doc, bin) {
  const json = Buffer.from(JSON.stringify(doc));
  const jsonPadded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(jsonPadded);
  const binPadded = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
  bin.copy(binPadded);
  const out = Buffer.alloc(28 + jsonPadded.length + binPadded.length);
  [0x46546c67, 2, out.length, jsonPadded.length, 0x4e4f534a].forEach((value, i) => out.writeUInt32LE(value, i * 4));
  jsonPadded.copy(out, 20);
  out.writeUInt32LE(binPadded.length, 20 + jsonPadded.length);
  out.writeUInt32LE(0x004e4942, 24 + jsonPadded.length);
  binPadded.copy(out, 28 + jsonPadded.length);
  return out;
}

/** Zdroj (GLB nebo glTF s jedním `.bin`) → `{ doc, bin }`, vnější obrázky vložené jako `bufferView`. */
async function load(file) {
  const bytes = await readFile(file);
  let doc;
  let bin;
  if (file.toLowerCase().endsWith('.glb')) ({ doc, bin } = readGlb(bytes));
  else {
    doc = JSON.parse(bytes.toString('utf8'));
    if (doc.buffers.length !== 1) fail(`${file}: expected one buffer`);
    bin = await readFile(path.join(path.dirname(file), decodeURIComponent(doc.buffers[0].uri)));
    delete doc.buffers[0].uri;
  }
  const chunks = [bin];
  let length = bin.length;
  for (const image of doc.images ?? []) {
    if (image.uri === undefined) continue;
    const original = await readFile(path.join(path.dirname(file), decodeURIComponent(image.uri)));
    const { width, height } = await sharp(original).metadata();
    const data = Math.max(width, height) > MAX_TEXTURE ? await sharp(original).resize(MAX_TEXTURE, MAX_TEXTURE, { fit: 'inside' }).toBuffer() : original;
    const pad = (4 - (length % 4)) % 4;
    chunks.push(Buffer.alloc(pad), data);
    doc.bufferViews.push({ buffer: 0, byteOffset: length + pad, byteLength: data.length });
    length += pad + data.length;
    image.bufferView = doc.bufferViews.length - 1;
    image.mimeType = /\.jpe?g$/i.test(image.uri) ? 'image/jpeg' : 'image/png';
    delete image.uri;
  }
  bin = Buffer.concat(chunks);
  doc.buffers = [{ byteLength: bin.length }];
  return { doc, bin };
}

/** Nechá jen `keep` animace a zahodí accessory a bufferViews, na které už nic neukazuje. */
function compact(doc, bin, keep) {
  doc.animations = (doc.animations ?? []).filter((animation) => keep.has(animation.name));
  const accessors = new Set();
  for (const mesh of doc.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      Object.values(primitive.attributes).forEach((index) => accessors.add(index));
      if (primitive.indices !== undefined) accessors.add(primitive.indices);
      for (const target of primitive.targets ?? []) Object.values(target).forEach((index) => accessors.add(index));
    }
  }
  for (const skin of doc.skins ?? []) if (skin.inverseBindMatrices !== undefined) accessors.add(skin.inverseBindMatrices);
  for (const animation of doc.animations) for (const sampler of animation.samplers) accessors.add(sampler.input).add(sampler.output);

  const accessorOrder = [...accessors].sort((a, b) => a - b);
  const accessorMap = new Map(accessorOrder.map((old, index) => [old, index]));
  const views = new Set(accessorOrder.map((index) => doc.accessors[index].bufferView).filter((view) => view !== undefined));
  for (const image of doc.images ?? []) if (image.bufferView !== undefined) views.add(image.bufferView);
  const viewOrder = [...views].sort((a, b) => a - b);
  const viewMap = new Map();
  const chunks = [];
  let length = 0;
  const bufferViews = viewOrder.map((old, index) => {
    const view = doc.bufferViews[old];
    const pad = (4 - (length % 4)) % 4;
    const start = view.byteOffset ?? 0;
    chunks.push(Buffer.alloc(pad), bin.subarray(start, start + view.byteLength));
    const byteOffset = length + pad;
    length = byteOffset + view.byteLength;
    viewMap.set(old, index);
    return { ...view, buffer: 0, byteOffset };
  });

  doc.accessors = accessorOrder.map((old) => {
    const accessor = { ...doc.accessors[old] };
    if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
    return accessor;
  });
  doc.bufferViews = bufferViews;
  for (const mesh of doc.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      for (const key of Object.keys(primitive.attributes)) primitive.attributes[key] = accessorMap.get(primitive.attributes[key]);
      if (primitive.indices !== undefined) primitive.indices = accessorMap.get(primitive.indices);
      for (const target of primitive.targets ?? []) for (const key of Object.keys(target)) target[key] = accessorMap.get(target[key]);
    }
  }
  for (const skin of doc.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = accessorMap.get(skin.inverseBindMatrices);
  for (const animation of doc.animations) {
    for (const sampler of animation.samplers) {
      sampler.input = accessorMap.get(sampler.input);
      sampler.output = accessorMap.get(sampler.output);
    }
  }
  for (const image of doc.images ?? []) if (image.bufferView !== undefined) image.bufferView = viewMap.get(image.bufferView);
  const packed = Buffer.concat(chunks);
  doc.buffers = [{ byteLength: packed.length }];
  return packed;
}

function localMatrix(node) {
  if (node.matrix !== undefined) return new Matrix4().fromArray(node.matrix);
  return new Matrix4().compose(new Vector3(...(node.translation ?? [0, 0, 0])), new Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new Vector3(...(node.scale ?? [1, 1, 1])));
}

/** Obal pozic všech meshů ve výchozí póze (rohy `min/max` přes světové matice uzlů). */
function bounds(doc) {
  const box = new Box3();
  const visit = (index, parent) => {
    const node = doc.nodes[index];
    const world = parent.clone().multiply(localMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of doc.meshes[node.mesh].primitives) {
        const { min, max } = doc.accessors[primitive.attributes.POSITION];
        for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) box.expandByPoint(new Vector3(x, y, z).applyMatrix4(world));
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of doc.scenes[doc.scene ?? 0].nodes) visit(root, new Matrix4());
  return box;
}

/** Kořen, který postaví postavu na podstavu a zmenší ji na `HEIGHT_M`. */
function standOnBase(doc) {
  const box = bounds(doc);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const scale = HEIGHT_M / Math.max(size.y, 1e-6);
  const round = (value) => Math.round(value * 1e6) / 1e6;
  const scene = doc.scenes[doc.scene ?? 0];
  doc.nodes.push({ name: 'RiggedRoot', translation: [round(-center.x * scale), round(-box.min.y * scale), round(-center.z * scale)], scale: [round(scale), round(scale), round(scale)], children: scene.nodes });
  scene.nodes = [doc.nodes.length - 1];
}

function triangles(doc) {
  let count = 0;
  for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives) count += doc.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3;
  return count;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Jedna postava → `{ ok, bytes, entry }` nebo `{ ok: false, reason }`. */
export async function buildCharacter(character, cacheDir, maxBytes = MAX_BYTES) {
  const file = path.join(cacheDir, character.source, ...character.file.split('/'));
  const { doc, bin } = await load(file);
  const names = new Set((doc.animations ?? []).map((animation) => animation.name));
  const clips = Object.fromEntries(Object.entries(character.clips).filter(([, clip]) => names.has(clip)));
  const missing = REQUIRED.filter((state) => clips[state] === undefined);
  if (missing.length > 0) return { ok: false, reason: `no clip for ${missing.join(', ')}` };
  const tris = triangles(doc);
  if (tris > MAX_TRIANGLES) return { ok: false, reason: `${tris} triangles over the ${MAX_TRIANGLES} budget` };
  const packed = compact(doc, bin, new Set(Object.values(clips)));
  standOnBase(doc);
  doc.asset = { ...doc.asset, generator: 'worldstream scripts/assets/rigged/build.mjs' };
  const bytes = writeGlb(doc, packed);
  if (bytes.length > maxBytes) return { ok: false, reason: `${bytes.length} bytes over the ${maxBytes} budget` };
  const report = await validator.validateBytes(new Uint8Array(bytes), { uri: `${character.id}.glb`, maxIssues: 50 });
  if (report.issues.numErrors > 0) return { ok: false, reason: `glTF validator: ${report.issues.messages.filter((m) => m.severity === 0).map((m) => m.code).join(', ')}` };
  return { ok: true, bytes, clips, triangles: tris, sourceFile: file };
}

async function main() {
  const fetched = JSON.parse(await readFile(path.join(HERE, 'fetched.json'), 'utf8'));
  const cacheDir = process.argv[2] ?? fetched.cacheDir;
  const sources = new Map(fetched.sources.map((source) => [source.id, source]));
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  /** Sestaví seznam postav do `OUT_DIR` a vrátí záznamy manifestu a vyřazené s důvodem. */
  const buildAll = async (list, maxBytes, plan) => {
    const characters = [];
    const excluded = [];
    for (const character of list) {
      const source = sources.get(character.source);
      if (source?.status !== 'fetched') {
        excluded.push({ id: character.id, reason: `source ${character.source} was not fetched` });
        continue;
      }
      const sourceFile = source.files.find((f) => f.path === `${character.source}/${character.file}`);
      const built = await buildCharacter(character, cacheDir, maxBytes);
      if (!built.ok) {
        excluded.push({ id: character.id, reason: built.reason });
        console.log(`excluded  ${character.id}  – ${built.reason}`);
        continue;
      }
      await writeFile(path.join(OUT_DIR, `${character.id}.glb`), built.bytes);
      characters.push({
        id: character.id,
        name: character.name,
        tags: character.tags,
        path: `${PUBLIC_PREFIX}/${character.id}.glb`,
        clips: built.clips,
        triangles: built.triangles,
        bytes: built.bytes.length,
        sha256: sha256(built.bytes),
        license: source.license,
        author: source.author,
        pack: source.name,
        page: source.page,
        sourceUrl: sourceFile?.url ?? null,
        sourceSha256: sourceFile?.sha256 ?? null,
        plan,
      });
      console.log(`built     ${character.id}  ${built.triangles} tris  ${(built.bytes.length / 1024).toFixed(0)} KB  ${Object.keys(built.clips).join(',')}`);
    }
    return { characters, excluded };
  };

  const base = await buildAll(CHARACTERS, MAX_BYTES, 'P26B');
  const p32 = await buildAll(P32_CHARACTERS, HERO_MAX_BYTES, 'P32C');
  const manifest = (comment, built) => `${JSON.stringify({ $comment: comment, version: 1, characters: built.characters.map(({ plan, ...character }) => character), excluded: built.excluded }, null, 2)}\n`;
  await writeFile(path.join(ROOT, 'src', 'assets', 'rigged.json'), manifest('Riggované CC0 postavy s klipy (P26B T4). Generuje scripts/assets/rigged/build.mjs – needitovat ručně. clips: stav hry → jméno klipu v GLB.', base));
  await writeFile(
    path.join(ROOT, 'src', 'assets', 'rigged-p32.json'),
    manifest('Animovaní hrdinové vět P32 (P32C T3), rozpočet 400 KB a textury 512 px. Generuje scripts/assets/rigged/build.mjs – needitovat ručně. clips: stav hry → jméno klipu v GLB; chybějící stav pohne kód.', p32),
  );
  const characters = [...base.characters, ...p32.characters];

  const packs = [...new Set(characters.map((c) => c.pack))];
  const provenance = [
    '# Riggované postavy – původ',
    '',
    'Generuje `scripts/assets/rigged/build.mjs` ze souborů, které stáhl `scripts/assets/rigged/fetch.mjs` (sha256 zdrojů v `scripts/assets/rigged/fetched.json`). Úpravy: jen namapované klipy, textury vložené do GLB (vnější nad 512 px zmenšené), kořenový uzel na podstavu a výšku 1,8 m. Geometrie ani klipy se nemění.',
    '',
    ...packs.map((pack) => {
      const first = characters.find((c) => c.pack === pack);
      return `- **${pack}** – ${first.author}, ${first.license}, ${first.page}: ${characters.filter((c) => c.pack === pack).map((c) => `\`${c.id}.glb\``).join(', ')}`;
    }),
    '',
    'CC0 nevyžaduje uvedení autora; uvádíme ho z vděčnosti.',
    '',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'PROVENANCE.md'), provenance);

  const disclosureFile = path.join(ROOT, 'disclosure.json');
  const disclosure = JSON.parse(await readFile(disclosureFile, 'utf8'));
  disclosure.entries = disclosure.entries.filter((entry) => !(entry.kind === 'asset' && entry.name.startsWith('public/assets/worldstream/rigged/')));
  for (const character of characters) {
    disclosure.entries.push({
      name: `public${character.path}`,
      kind: 'asset',
      firstParty: false,
      reason: `Rigged animated character "${character.name}" for arcade roles (${character.plan}); clips reduced to the game states, textures embedded, re-rooted on its base.`,
      source: `${character.pack} – ${character.sourceUrl}`,
      authorOrProvider: character.author,
      license: character.license,
      requiredNotices: ['žádné — CC0 se vzdává i práva na atribuci'],
      attribution: `${character.name} from ${character.pack} by ${character.author} (${character.license}), ${character.page}`,
      reviewNote: 'Licence text downloaded next to the source and checked by scripts/assets/rigged/fetch.mjs; see public/assets/worldstream/rigged/PROVENANCE.md.',
      scope: 'prod',
    });
  }
  disclosure.entries.push({
    name: 'public/assets/worldstream/rigged/PROVENANCE.md',
    kind: 'asset',
    firstParty: true,
    reason: 'Provenance document for the rigged CC0 characters, generated by scripts/assets/rigged/build.mjs.',
    source: 'scripts/assets/rigged/build.mjs',
    authorOrProvider: 'Worldsmith project',
    license: 'LicenseRef-Worldsmith-Original',
    requiredNotices: ['No third-party asset notice; project documentation.'],
    attribution: 'Worldsmith project provenance document, 2026-09-24.',
    reviewNote: 'Generated document listing sources and licences; no third-party content.',
    scope: 'prod',
  });
  await writeFile(disclosureFile, `${JSON.stringify(disclosure, null, 2)}\n`);
  console.log(`${characters.length} characters, ${base.excluded.length + p32.excluded.length} excluded`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
