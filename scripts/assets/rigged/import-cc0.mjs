#!/usr/bin/env node
/**
 * Animované CC0 postavy Quaternius s kostrou a klipy (P54B T3).
 *
 *   node scripts/assets/rigged/import-cc0.mjs [--cache <dir>] [--stage <dir>]
 *
 * Bere `.gltf` z cache CC0 (`scripts/assets/cc0/fetch.mjs`, buffery jsou base64
 * `data:` URI, proto `@gltf-transform` místo `load()` z `build.mjs`) a každou
 * postavu z `CHARACTERS` převezme **se zachovanou kostrou a klipy**:
 *
 * - klipy se namapují na stavy hry (`STATE_CLIPS`); postava bez `idle`
 *   a `walk|run` se vyřadí, ostatní klipy zahodí a zbylé převzorkují;
 * - barvy materiálů (a textura z palety – atlas plochých políček) se zapečou
 *   do COLOR_0 pod jeden bílý materiál, `mergeRig` pak slije postavu do jednoho
 *   volání; malovaná textura zůstane, zmenšená nejvýš na `MAX_TEXTURE`;
 * - postava, jejíž převažující odstín je fialový (`isPurple` je barevná rodina
 *   s největší plochou, šedé a černé se nepočítají), se vyřadí – pravidlo projektu;
 * - lidé UAC dostanou místo autorovy skoro černé kůže přirozený odstín (`SKIN_TONES`);
 * - nad `MAX_TRIANGLES` se zjednoduší (meshopt), co se nevejde, se vyřadí;
 * - kořen `RiggedRoot` ji postaví na podstavu a zmenší na 1,8 m – měřeno
 *   v první póze klipu `idle` přes kosti, ne v T-póze;
 * - dopředu je +z (Quaternius tak exportuje; `yaw` balíku by to otočil).
 *
 * Píše `public/assets/worldstream/rigged/q-*.glb`, texty licencí balíků do
 * `public/assets/worldstream/cc0/licenses/`, manifest `src/assets/rigged-p54.json`
 * a položky obojího do `disclosure.json` + `DISCLOSURE.md`. S `--stage <dir>`
 * jdou GLB a licence do `<dir>` a registr zůstane – nové soubory v `public/`
 * by shodily licenční bránu každému commitu, dokud nejsou v registru.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, joinPrimitives, prune, resample, simplify, weld } from '@gltf-transform/functions';
import validator from 'gltf-validator';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';

import { hueSat, isPurple, toSrgb } from '../cc0/palette.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const PUBLIC_PREFIX = '/assets/worldstream/rigged';
const LICENSES = 'assets/worldstream/cc0/licenses';
export const CACHE_DIR = 'D:/claude/_cc0-cache';
export const MAX_TRIANGLES = 7000;
export const MAX_BYTES = 1.5 * 1024 * 1024;
export const MAX_TEXTURE = 512;
export const HEIGHT_M = 1.8;
/** Textura je paleta, když aspoň tolik trojúhelníků čte ve všech třech vrcholech tutéž barvu. */
const PALETTE_UNIFORM = 0.9;

/** Stav hry → jména klipů v balících Quaternius v pořadí přednosti. Útok (`shoot`) je jen úder zblízka. */
export const STATE_CLIPS = {
  idle: ['Idle', 'Flying_Idle'],
  walk: ['Walk'],
  run: ['Run', 'Gallop', 'Fast_Flying'],
  jump: ['Jump', 'Gallop_Jump'],
  hit: ['RecieveHit', 'HitReact', 'HitRecieve', 'Idle_HitReact1'],
  die: ['Death'],
  win: ['Victory', 'Yes', 'Dance'],
  shoot: ['Punch', 'SwordSlash', 'Bite_Front', 'Attack', 'Attack_Headbutt', 'Headbutt'],
};
export const STATES = Object.keys(STATE_CLIPS);

export function clipMap(names) {
  const present = new Set(names);
  const out = {};
  for (const [state, candidates] of Object.entries(STATE_CLIPS)) {
    const found = candidates.find((name) => present.has(name));
    if (found !== undefined) out[state] = found;
  }
  return out;
}

export function missingClips(clips) {
  if (clips.idle === undefined) return 'no clip for idle';
  if (clips.walk === undefined && clips.run === undefined) return 'no clip for walk or run';
  return null;
}

// ---------------------------------------------------------------------------
// Postavy: [soubor v balíku bez přípony, id, jméno, třída, tagy identity]

const UAC = 'quaternius-ultimate-animated-character';
const ANIMALS = 'quaternius-ultimate-animated-animals';
const RPG = 'quaternius-rpg-characters';
const CUTE = 'quaternius-cute-monsters';
const MONSTERS = 'quaternius-ultimate-monsters';

export const PACK_NAMES = {
  [UAC]: 'Quaternius Ultimate Animated Character Pack',
  [ANIMALS]: 'Quaternius Ultimate Animated Animals',
  [RPG]: 'Quaternius RPG Characters',
  [CUTE]: 'Quaternius Cute Animated Monsters',
  [MONSTERS]: 'Quaternius Ultimate Monsters',
};

const pack = (source, dir, rows) => rows.map(([file, id, name, kind, tags]) => ({ source, file: `${dir}${file}.gltf`, id, name, class: kind, tags }));

/**
 * Tag je podstatné jméno, které postavu opravdu jmenuje. Předmět, který bývá
 * překážkou nebo sběrem („tree“, „cactus“, „mushroom“, „fish“), příšera
 * nedostane holý – jinak by strom z věty začal chodit.
 */
export const CHARACTERS = [
  ...pack(UAC, 'glTF/', [
    ['BaseCharacter', 'q-person', 'Person', 'humanoid', ['person', 'human']],
    ['BlueSoldier_Female', 'q-blue-soldier-woman', 'Blue Soldier (woman)', 'humanoid', ['soldier', 'trooper', 'guard']],
    ['BlueSoldier_Male', 'q-blue-soldier', 'Blue Soldier', 'humanoid', ['soldier', 'trooper', 'guard']],
    ['Casual_Female', 'q-casual-woman', 'Casual Woman', 'humanoid', ['woman', 'lady']],
    ['Casual_Male', 'q-casual-man', 'Casual Man', 'humanoid', ['man', 'guy']],
    ['Casual2_Female', 'q-casual-woman-b', 'Casual Woman B', 'humanoid', ['woman', 'lady']],
    ['Casual2_Male', 'q-casual-man-b', 'Casual Man B', 'humanoid', ['man', 'guy']],
    ['Casual3_Female', 'q-casual-woman-c', 'Casual Woman C', 'humanoid', ['woman', 'lady']],
    ['Casual3_Male', 'q-casual-man-c', 'Casual Man C', 'humanoid', ['man', 'guy']],
    ['Casual_Bald', 'q-bald-man', 'Bald Man', 'humanoid', ['man', 'bald']],
    ['Chef_Male', 'q-chef', 'Chef', 'humanoid', ['chef', 'cook']],
    ['Chef_Female', 'q-chef-woman', 'Chef (woman)', 'humanoid', ['chef', 'cook']],
    ['Chef_Hat', 'q-chef-hat', 'Chef with Hat', 'humanoid', ['chef', 'cook', 'baker']],
    ['Cow', 'q-cow-costume', 'Cow Costume', 'humanoid', ['cow-costume', 'mascot']],
    ['Cowboy_Male', 'q-cowboy', 'Cowboy', 'humanoid', ['cowboy', 'sheriff', 'rancher']],
    ['Cowboy_Female', 'q-cowgirl', 'Cowgirl', 'humanoid', ['cowgirl', 'cowboy', 'rancher']],
    ['Cowboy_Hair', 'q-cowboy-hair', 'Cowboy (hair)', 'humanoid', ['cowboy', 'rancher']],
    ['Doctor_Male_Young', 'q-doctor', 'Doctor', 'humanoid', ['doctor', 'medic', 'scientist']],
    ['Doctor_Male_Old', 'q-doctor-old', 'Old Doctor', 'humanoid', ['doctor', 'medic', 'scientist']],
    ['Doctor_Female_Young', 'q-doctor-woman', 'Doctor (woman)', 'humanoid', ['doctor', 'medic', 'nurse']],
    ['Doctor_Female_Old', 'q-doctor-woman-old', 'Old Doctor (woman)', 'humanoid', ['doctor', 'medic', 'nurse']],
    ['Elf', 'q-elf', 'Elf', 'humanoid', ['elf']],
    ['Goblin_Male', 'q-goblin', 'Goblin', 'monster', ['goblin']],
    ['Goblin_Female', 'q-goblin-woman', 'Goblin (woman)', 'monster', ['goblin']],
    ['Kimono_Male', 'q-samurai', 'Samurai', 'humanoid', ['samurai', 'kimono']],
    ['Kimono_Female', 'q-kimono-woman', 'Kimono (woman)', 'humanoid', ['kimono']],
    ['Knight_Male', 'q-knight', 'Knight', 'humanoid', ['knight']],
    ['Knight_Golden_Male', 'q-golden-knight', 'Golden Knight', 'humanoid', ['knight', 'paladin']],
    ['Knight_Golden_Female', 'q-golden-knight-woman', 'Golden Knight (woman)', 'humanoid', ['knight', 'paladin']],
    ['Ninja_Male', 'q-ninja', 'Ninja', 'humanoid', ['ninja']],
    ['Ninja_Female', 'q-ninja-woman', 'Ninja (woman)', 'humanoid', ['ninja']],
    ['Ninja_Male_Hair', 'q-ninja-hair', 'Ninja (hair)', 'humanoid', ['ninja']],
    ['Ninja_Sand', 'q-sand-ninja', 'Sand Ninja', 'humanoid', ['ninja']],
    ['Ninja_Sand_Female', 'q-sand-ninja-woman', 'Sand Ninja (woman)', 'humanoid', ['ninja']],
    ['OldClassy_Female', 'q-grandma', 'Grandma', 'humanoid', ['grandma', 'granny', 'grandmother']],
    ['OldClassy_Male', 'q-grandpa', 'Grandpa', 'humanoid', ['grandpa', 'grandfather', 'gentleman']],
    ['Pirate_Male', 'q-pirate', 'Pirate', 'humanoid', ['pirate', 'buccaneer', 'captain']],
    ['Pirate_Female', 'q-pirate-woman', 'Pirate (woman)', 'humanoid', ['pirate', 'buccaneer']],
    ['Pug', 'q-pug-costume', 'Pug Costume', 'humanoid', ['pug-costume', 'mascot']],
    ['Soldier_Male', 'q-soldier', 'Soldier', 'humanoid', ['soldier']],
    ['Soldier_Female', 'q-soldier-woman', 'Soldier (woman)', 'humanoid', ['soldier']],
    // Ne „boss“: ve hře je to závěrečný nepřítel, ne pán v obleku.
    ['Suit_Male', 'q-businessman', 'Businessman', 'humanoid', ['businessman', 'agent', 'spy']],
    ['Suit_Female', 'q-businesswoman', 'Businesswoman', 'humanoid', ['businesswoman', 'manager']],
    ['Viking_Male', 'q-viking', 'Viking', 'humanoid', ['viking']],
    ['Viking_Female', 'q-viking-woman', 'Viking (woman)', 'humanoid', ['viking', 'shieldmaiden']],
    ['VikingHelmet', 'q-viking-helmet', 'Viking with Helmet', 'humanoid', ['viking']],
    ['Witch', 'q-witch', 'Witch', 'humanoid', ['witch']],
    ['Wizard', 'q-wizard', 'Wizard', 'humanoid', ['wizard', 'sorcerer']],
    ['Worker_Male', 'q-worker', 'Worker', 'humanoid', ['worker', 'builder']],
    ['Worker_Female', 'q-worker-woman', 'Worker (woman)', 'humanoid', ['worker', 'builder']],
    ['Zombie_Male', 'q-zombie', 'Zombie', 'monster', ['zombie', 'undead']],
    ['Zombie_Female', 'q-zombie-woman', 'Zombie (woman)', 'monster', ['zombie']],
  ]),
  ...pack(ANIMALS, 'glTF/', [
    ['Alpaca', 'q-alpaca', 'Alpaca', 'animal', ['alpaca', 'llama']],
    ['Bull', 'q-bull', 'Bull', 'animal', ['bull', 'ox', 'buffalo']],
    ['Cow', 'q-cow', 'Cow', 'animal', ['cow', 'cattle']],
    ['Deer', 'q-deer', 'Deer', 'animal', ['deer', 'doe']],
    ['Donkey', 'q-donkey', 'Donkey', 'animal', ['donkey', 'mule']],
    ['Fox', 'q-fox', 'Fox', 'animal', ['fox']],
    ['Horse', 'q-horse', 'Horse', 'animal', ['horse', 'pony', 'stallion']],
    ['Horse_White', 'q-white-horse', 'White Horse', 'animal', ['horse', 'mare']],
    ['Husky', 'q-husky', 'Husky', 'animal', ['husky', 'dog']],
    ['ShibaInu', 'q-shiba', 'Shiba Inu', 'animal', ['shiba', 'dog']],
    ['Stag', 'q-stag', 'Stag', 'animal', ['stag', 'elk', 'reindeer']],
    ['Wolf', 'q-wolf', 'Wolf', 'animal', ['wolf']],
  ]),
  ...pack(RPG, 'glTF/', [
    ['Cleric', 'q-cleric', 'Cleric', 'humanoid', ['cleric', 'priest', 'healer']],
    ['Monk', 'q-monk', 'Monk', 'humanoid', ['monk']],
    ['Ranger', 'q-ranger', 'Ranger', 'humanoid', ['ranger', 'archer', 'hunter']],
    ['Rogue', 'q-rogue', 'Rogue', 'humanoid', ['rogue', 'thief']],
    ['Warrior', 'q-warrior', 'Warrior', 'humanoid', ['warrior', 'fighter']],
    ['Wizard', 'q-rpg-wizard', 'RPG Wizard', 'humanoid', ['wizard', 'mage']],
  ]),
  ...pack(CUTE, 'glTF/', [
    ['Alien', 'q-cute-alien', 'Cute Alien', 'monster', ['alien']],
    ['Alien_Tall', 'q-cute-alien-tall', 'Tall Alien', 'monster', ['alien']],
    ['Bat', 'q-cute-bat', 'Bat', 'animal', ['bat']],
    ['Bee', 'q-cute-bee', 'Bee', 'animal', ['bee']],
    ['Cactus', 'q-cute-cactus', 'Cactus Monster', 'monster', ['cactus-monster']],
    ['Chicken', 'q-cute-chicken', 'Chicken', 'bird', ['chicken', 'hen']],
    ['Crab', 'q-cute-crab', 'Crab', 'animal', ['crab']],
    ['Cthulhu', 'q-cute-cthulhu', 'Cthulhu', 'monster', ['cthulhu', 'kraken']],
    ['Cyclops', 'q-cute-cyclops', 'Cyclops', 'monster', ['cyclops']],
    ['Deer', 'q-cute-fawn', 'Fawn', 'animal', ['fawn', 'deer']],
    ['Demon', 'q-cute-demon', 'Demon', 'monster', ['demon', 'devil', 'imp']],
    ['Ghost', 'q-cute-ghost', 'Ghost', 'monster', ['ghost', 'spirit']],
    ['GreenDemon', 'q-cute-green-demon', 'Green Demon', 'monster', ['demon', 'imp']],
    ['Mushroom', 'q-cute-mushroom', 'Mushroom Monster', 'monster', ['mushroom-monster']],
    ['Panda', 'q-cute-panda', 'Panda', 'animal', ['panda']],
    ['Penguin', 'q-cute-penguin', 'Penguin', 'bird', ['penguin']],
    ['Pig', 'q-cute-pig', 'Pig', 'animal', ['pig', 'piglet', 'hog']],
    ['Skull', 'q-cute-skull', 'Skull Monster', 'monster', ['skull']],
    ['Tree', 'q-cute-tree', 'Tree Monster', 'monster', ['treant', 'tree-monster']],
    ['YellowDragon', 'q-cute-dragon', 'Yellow Dragon', 'monster', ['dragon']],
    ['Yeti', 'q-cute-yeti', 'Yeti', 'monster', ['yeti', 'bigfoot', 'sasquatch']],
  ]),
  ...pack(MONSTERS, 'Big/glTF/', [
    ['Alien', 'q-big-alien', 'Big Alien', 'monster', ['alien']],
    ['Birb', 'q-big-birb', 'Birb', 'monster', ['birb']],
    ['BlueDemon', 'q-big-blue-demon', 'Blue Demon', 'monster', ['demon']],
    ['Bunny', 'q-big-bunny', 'Bunny Monster', 'monster', ['bunny']],
    ['Cactoro', 'q-big-cactoro', 'Cactoro', 'monster', ['cactoro']],
    ['Demon', 'q-big-demon', 'Big Demon', 'monster', ['demon']],
    ['Dino', 'q-big-dino', 'Dino', 'monster', ['dino']],
    ['Fish', 'q-big-fish', 'Fishman', 'monster', ['fishman', 'merman']],
    // Ne „frog“: žábu z věty kreslí vlastní model `gen3d-frog` (P37D), ne válečník s žabí hlavou.
    ['Frog', 'q-big-frog', 'Frog Monster', 'monster', ['frogman']],
    ['Monkroose', 'q-big-monkroose', 'Monkroose', 'monster', ['monkroose']],
    ['MushroomKing', 'q-big-mushroom-king', 'Mushroom King', 'monster', ['mushroom-king']],
    ['Ninja', 'q-big-ninja', 'Ninja Monster', 'monster', ['ninja']],
    ['Orc', 'q-big-orc', 'Orc', 'monster', ['orc', 'ogre']],
    ['Orc_Skull', 'q-big-orc-skull', 'Skull Orc', 'monster', ['orc']],
    ['Tribal', 'q-big-tribal', 'Tribal', 'monster', ['shaman']],
    ['Yeti', 'q-big-yeti', 'Big Yeti', 'monster', ['yeti']],
  ]),
  ...pack(MONSTERS, 'Blob/glTF/', [
    ['Alien', 'q-blob-alien', 'Alien Blob', 'monster', ['alien']],
    ['Birb', 'q-blob-birb', 'Birb Blob', 'monster', ['birb']],
    ['Cactoro', 'q-blob-cactoro', 'Cactoro Blob', 'monster', ['cactoro']],
    ['Cat', 'q-blob-cat', 'Cat Blob', 'animal', ['cat']],
    ['Chicken', 'q-blob-chicken', 'Chicken Blob', 'bird', ['chicken']],
    ['Dog', 'q-blob-dog', 'Dog Blob', 'animal', ['dog']],
    ['Fish', 'q-blob-fish', 'Fish Blob', 'monster', ['fish-blob']],
    ['GreenBlob', 'q-blob-green', 'Green Blob', 'monster', ['blob', 'slime']],
    ['GreenSpikyBlob', 'q-blob-spiky', 'Spiky Blob', 'monster', ['blob', 'slime']],
    ['Mushnub', 'q-blob-mushnub', 'Mushnub', 'monster', ['mushnub']],
    ['Mushnub_Evolved', 'q-blob-mushnub-evolved', 'Mushnub Evolved', 'monster', ['mushnub']],
    ['Ninja', 'q-blob-ninja', 'Ninja Blob', 'monster', ['ninja']],
    ['Orc', 'q-blob-orc', 'Orc Blob', 'monster', ['orc']],
    ['Pigeon', 'q-blob-pigeon', 'Pigeon Blob', 'bird', ['pigeon']],
    ['PinkBlob', 'q-blob-pink', 'Pink Blob', 'monster', ['blob', 'slime']],
    ['Wizard', 'q-blob-wizard', 'Wizard Blob', 'monster', ['wizard']],
    ['Yeti', 'q-blob-yeti', 'Yeti Blob', 'monster', ['yeti']],
  ]),
  ...pack(MONSTERS, 'Flying/glTF/', [
    ['Alpaking', 'q-flying-alpaking', 'Alpaking', 'monster', ['alpaking']],
    ['Alpaking_Evolved', 'q-flying-alpaking-evolved', 'Alpaking Evolved', 'monster', ['alpaking']],
    ['Armabee', 'q-flying-armabee', 'Armabee', 'monster', ['armabee']],
    ['Armabee_Evolved', 'q-flying-armabee-evolved', 'Armabee Evolved', 'monster', ['armabee']],
    ['Demon', 'q-flying-demon', 'Flying Demon', 'monster', ['demon']],
    ['Dragon', 'q-flying-dragon', 'Dragon', 'monster', ['dragon', 'wyvern']],
    ['Dragon_Evolved', 'q-flying-dragon-evolved', 'Dragon Evolved', 'monster', ['dragon']],
    ['Ghost', 'q-flying-ghost', 'Flying Ghost', 'monster', ['ghost']],
    ['Ghost_Skull', 'q-flying-ghost-skull', 'Skull Ghost', 'monster', ['ghost', 'skull']],
    ['Glub', 'q-flying-glub', 'Glub', 'monster', ['glub']],
    ['Glub_Evolved', 'q-flying-glub-evolved', 'Glub Evolved', 'monster', ['glub']],
    ['Goleling', 'q-flying-goleling', 'Goleling', 'monster', ['goleling', 'golem']],
    ['Goleling_Evolved', 'q-flying-goleling-evolved', 'Goleling Evolved', 'monster', ['goleling', 'golem']],
    ['Hywirl', 'q-flying-hywirl', 'Hywirl', 'monster', ['hywirl']],
    ['Pigeon', 'q-flying-pigeon', 'Flying Pigeon', 'bird', ['pigeon', 'dove']],
    ['Squidle', 'q-flying-squidle', 'Squidle', 'monster', ['squidle']],
    ['Tribal', 'q-flying-tribal', 'Flying Tribal', 'monster', ['tiki']],
  ]),
];

// ---------------------------------------------------------------------------
// Póza, plocha a barvy

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Světová matice uzlu v první póze klipu `clip` (klidové TRS přepsané prvním klíčem kanálu). */
function poseOf(doc, clip) {
  const overrides = new Map();
  const animation = doc.getRoot().listAnimations().find((candidate) => candidate.getName() === clip);
  for (const channel of animation?.listChannels() ?? []) {
    const node = channel.getTargetNode();
    const sampler = channel.getSampler();
    const target = channel.getTargetPath();
    if (node === null || sampler === null || target === 'weights') continue;
    const value = sampler.getOutput().getElement(sampler.getInterpolation() === 'CUBICSPLINE' ? 1 : 0, []);
    overrides.set(node, { ...overrides.get(node), [target]: value });
  }
  const world = new Map();
  const worldOf = (node) => {
    let matrix = world.get(node);
    if (matrix !== undefined) return matrix;
    const own = overrides.get(node) ?? {};
    matrix = new Matrix4().compose(new Vector3(...(own.translation ?? node.getTranslation())), new Quaternion(...(own.rotation ?? node.getRotation())), new Vector3(...(own.scale ?? node.getScale())));
    const parent = node.getParentNode();
    if (parent !== null) matrix = worldOf(parent).clone().multiply(matrix);
    world.set(node, matrix);
    return matrix;
  };
  return worldOf;
}

/** Každé primitivum s pozicemi vrcholů v póze: skinovaná síť přes klouby, tuhá přes svůj uzel. */
function posedPrimitives(doc, clip) {
  const worldOf = poseOf(doc, clip);
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    const skin = node.getSkin();
    const inverse = skin?.getInverseBindMatrices();
    const joints = skin?.listJoints().map((joint, index) => worldOf(joint).clone().multiply(inverse ? new Matrix4().fromArray(inverse.getElement(index, [])) : new Matrix4())) ?? null;
    const own = worldOf(node);
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const jointIndex = primitive.getAttribute('JOINTS_0');
      const jointWeight = primitive.getAttribute('WEIGHTS_0');
      const skinned = joints !== null && jointIndex !== null && jointWeight !== null;
      const posed = new Float32Array(position.getCount() * 3);
      const vertex = new Vector3();
      const sum = new Vector3();
      const part = new Vector3();
      const [p, j, w] = [[], [], []];
      for (let i = 0; i < position.getCount(); i += 1) {
        vertex.fromArray(position.getElement(i, p));
        if (skinned) {
          jointIndex.getElement(i, j);
          jointWeight.getElement(i, w);
          sum.set(0, 0, 0);
          for (let k = 0; k < 4; k += 1) if (w[k] > 0) sum.add(part.copy(vertex).applyMatrix4(joints[j[k]]).multiplyScalar(w[k]));
          sum.toArray(posed, i * 3);
        } else vertex.applyMatrix4(own).toArray(posed, i * 3);
      }
      out.push({ primitive, posed });
    }
  }
  return out;
}

function boundsOf(posedList) {
  const box = new Box3();
  const point = new Vector3();
  for (const { posed } of posedList) for (let i = 0; i < posed.length; i += 3) box.expandByPoint(point.fromArray(posed, i));
  return box;
}

/** Trojúhelníky primitiva jako trojice indexů vrcholů. */
function triangleIndices(primitive) {
  const indices = primitive.getIndices();
  const count = indices ? indices.getCount() : primitive.getAttribute('POSITION').getCount();
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = indices ? indices.getScalar(i) : i;
  return out;
}

function triangleCount(doc) {
  let count = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3;
  return count;
}

/** Rozbalený obrázek textury pro čtení po pixelech (RGBA, sRGB 0–255). */
async function pixelsOf(texture, cache) {
  let pixels = cache.get(texture);
  if (pixels === undefined) {
    const { data, info } = await sharp(texture.getImage()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pixels = { data, width: info.width, height: info.height };
    cache.set(texture, pixels);
  }
  return pixels;
}

/** Lineární RGB textury v souřadnici UV (nejbližší pixel, opakování). */
function sample({ data, width, height }, u, v) {
  const x = Math.min(width - 1, Math.floor((u - Math.floor(u)) * width));
  const y = Math.min(height - 1, Math.floor((v - Math.floor(v)) * height));
  const at = (y * width + x) * 4;
  return [toLinear(data[at] / 255), toLinear(data[at + 1] / 255), toLinear(data[at + 2] / 255)];
}

/**
 * Zapeče barvy materiálů do COLOR_0 pod jeden bílý materiál. Textura se zapeče
 * jen když je paletou (`PALETTE_UNIFORM` trojúhelníků jednobarevných), malovaná
 * zůstane a zmenší se na `MAX_TEXTURE`. Vrací největší stranu zachované textury.
 */
async function bakeColours(doc) {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const pixels = new Map();
  const uvColours = new Map();
  /** Barvy vrcholů primitiva z textury a podíl jednobarevných trojúhelníků. */
  const fromTexture = async (primitive, texture) => {
    const uv = primitive.getAttribute(`TEXCOORD_${primitive.getMaterial().getBaseColorTextureInfo()?.getTexCoord() ?? 0}`);
    const image = await pixelsOf(texture, pixels);
    const colours = [];
    const element = [];
    for (let i = 0; i < uv.getCount(); i += 1) colours.push(sample(image, ...uv.getElement(i, element)));
    const triangles = triangleIndices(primitive);
    let uniform = 0;
    const same = (a, b) => a.every((value, channel) => Math.abs(value - b[channel]) < 1e-3);
    for (let t = 0; t < triangles.length; t += 3) if (same(colours[triangles[t]], colours[triangles[t + 1]]) && same(colours[triangles[t]], colours[triangles[t + 2]])) uniform += 1;
    return { colours, uniform, triangles: triangles.length / 3 };
  };

  // Paleta, nebo malba: rozhoduje textura jako celek, ne primitivum.
  const verdict = new Map();
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const texture = primitive.getMaterial()?.getBaseColorTexture();
      if (!texture) continue;
      const read = await fromTexture(primitive, texture);
      uvColours.set(primitive, read.colours);
      const tally = verdict.get(texture) ?? { uniform: 0, triangles: 0 };
      verdict.set(texture, { uniform: tally.uniform + read.uniform, triangles: tally.triangles + read.triangles });
    }
  }
  const palette = (texture) => {
    const tally = verdict.get(texture);
    return tally.uniform / Math.max(1, tally.triangles) >= PALETTE_UNIFORM;
  };

  const body = doc.createMaterial('Body').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.8).setDoubleSided(true);
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      const texture = material?.getBaseColorTexture() ?? null;
      if (texture !== null && !palette(texture)) continue;
      const factor = material?.getBaseColorFactor() ?? [1, 1, 1, 1];
      const count = primitive.getAttribute('POSITION').getCount();
      const existing = primitive.getAttribute('COLOR_0');
      const fromUv = texture === null ? null : uvColours.get(primitive);
      const colours = new Float32Array(count * 3);
      const element = [];
      for (let i = 0; i < count; i += 1) {
        const base = existing ? existing.getElement(i, element) : [1, 1, 1];
        const texel = fromUv ? fromUv[i] : [1, 1, 1];
        for (let c = 0; c < 3; c += 1) colours[i * 3 + c] = factor[c] * base[c] * texel[c];
      }
      primitive.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(colours).setBuffer(buffer));
      for (const semantic of primitive.listSemantics()) if (semantic.startsWith('TEXCOORD_')) primitive.setAttribute(semantic, null);
      primitive.setMaterial(body);
    }
  }

  let largest = 0;
  for (const texture of root.listTextures()) {
    const used = texture.listParents().some((parent) => parent !== root);
    if (!used || verdict.get(texture) === undefined || palette(texture)) continue;
    const [width, height] = texture.getSize();
    if (Math.max(width, height) > MAX_TEXTURE) {
      texture.setImage(await sharp(texture.getImage()).resize(MAX_TEXTURE, MAX_TEXTURE, { fit: 'inside' }).png().toBuffer()).setMimeType('image/png');
    }
    largest = Math.max(largest, ...texture.getSize());
  }
  return largest;
}

/**
 * Barva a plocha každého trojúhelníku v póze. Zapečené primitivum čte COLOR_0,
 * malované texturu ve vrcholech (průměr tří), obojí krát barva materiálu.
 */
async function surface(doc, posedList) {
  const pixels = new Map();
  const out = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (const { primitive, posed } of posedList) {
    const material = primitive.getMaterial();
    const factor = material?.getBaseColorFactor() ?? [1, 1, 1, 1];
    const texture = material?.getBaseColorTexture() ?? null;
    const image = texture === null ? null : await pixelsOf(texture, pixels);
    const uv = texture === null ? null : primitive.getAttribute(`TEXCOORD_${material.getBaseColorTextureInfo()?.getTexCoord() ?? 0}`);
    const colour = primitive.getAttribute('COLOR_0');
    const element = [];
    const vertexColour = (i) => {
      const base = colour ? colour.getElement(i, element).slice(0, 3) : [1, 1, 1];
      const texel = image ? sample(image, ...uv.getElement(i, [])) : [1, 1, 1];
      return base.map((value, channel) => value * texel[channel] * factor[channel]);
    };
    const triangles = triangleIndices(primitive);
    for (let t = 0; t < triangles.length; t += 3) {
      const [i, j, k] = [triangles[t], triangles[t + 1], triangles[t + 2]];
      a.fromArray(posed, i * 3);
      b.fromArray(posed, j * 3).sub(a);
      c.fromArray(posed, k * 3).sub(a);
      const area = b.cross(c).length() / 2;
      if (area === 0) continue;
      const [ci, cj, ck] = [vertexColour(i), vertexColour(j), vertexColour(k)];
      out.push({ area, linear: [0, 1, 2].map((channel) => (ci[channel] + cj[channel] + ck[channel]) / 3) });
    }
  }
  return out;
}

const hex = (linear) => `#${toSrgb(linear).map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * Přirozené odstíny kůže (sRGB) od světlé po tmavě hnědou. Lidé balíku UAC mají
 * kůži skoro černou (lineárně 0,013) s bílýma očima – autorova silueta, ve hře
 * pro spotřebitele ale karikatura; dostanou jeden z těchto odstínů podle id.
 */
export const SKIN_TONES = ['#f2d0b1', '#e3b48f', '#c99068', '#a8714a', '#7d4e31', '#5a3622'];

/** Odstín kůže postavy: stálý podle id (sha256), ať přestavba nic nepřehodí. */
export const skinToneOf = (id) => SKIN_TONES[createHash('sha256').update(id).digest()[0] % SKIN_TONES.length];

/**
 * Primitiva se skoro černým materiálem `Skin` lidí UAC, sebraná před zapečením
 * (pak je materiál jeden). Zelená kůže skřeta a zombie černá není a zůstane.
 */
function skinPrimitives(doc, character) {
  if (character.source !== UAC) return [];
  const out = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (material?.getName() === 'Skin' && material.getBaseColorTexture() === null && Math.max(...material.getBaseColorFactor().slice(0, 3)) < 0.05) out.push(primitive);
    }
  }
  return out;
}

/** Zapečenou barvu kůže přepíše přirozeným odstínem postavy. */
function paintSkin(doc, primitives, id) {
  const linear = [1, 3, 5].map((at) => toLinear(parseInt(skinToneOf(id).slice(at, at + 2), 16) / 255));
  const buffer = doc.getRoot().listBuffers()[0];
  for (const primitive of primitives) {
    const count = primitive.getAttribute('POSITION').getCount();
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) colours.set(linear, i * 3);
    primitive.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(colours).setBuffer(buffer));
  }
}

/** Barevná rodina pod tímhle podílem plochy je detail (jazyk pandy), ne odstín postavy. */
const DETAIL_SHARE = 0.05;

/**
 * Rodina odstínu barvy sRGB; `neutral` = šedá, černá, bílá (sytost do 0,25 jako
 * `isPurple`, nebo skoro černá, kde odstín není vidět). Fialová je přesně 250–320°.
 */
function hueFamily(srgb) {
  const { hue, sat } = hueSat(srgb);
  if (sat <= 0.25 || Math.max(...srgb) < 0.1) return 'neutral';
  if (isPurple(srgb)) return 'purple';
  if (hue < 20 || hue > 320) return 'red';
  if (hue < 50) return 'orange';
  if (hue < 75) return 'yellow';
  return hue < 165 ? 'green' : 'blue';
}

/** Kloní se k fialové (švestková, lila): záložní barvou být nesmí, i když pravidlo 250–320° mine. */
const leansPurple = (srgb) => {
  const { hue, sat } = hueSat(srgb);
  return sat > 0.25 && hue >= 240 && hue <= 345;
};

/**
 * Převažující odstín = barevná rodina s největší plochou, aspoň `DETAIL_SHARE`
 * povrchu (neutrální se nepočítá: černá postava s fialovým tričkem je fialová).
 * Záložní barva = plošně největší barva (sRGB po 1/16), která se ke fialové nekloní.
 */
function colourStats(triangles) {
  let total = 0;
  const families = new Map();
  const buckets = new Map();
  for (const { area, linear } of triangles) {
    total += area;
    const srgb = toSrgb(linear);
    const family = hueFamily(srgb);
    families.set(family, (families.get(family) ?? 0) + area);
    if (leansPurple(srgb)) continue;
    const key = srgb.map((value) => Math.round(value * 15)).join(',');
    const bucket = buckets.get(key) ?? { area: 0, sum: [0, 0, 0] };
    bucket.area += area;
    linear.forEach((value, channel) => (bucket.sum[channel] += value * area));
    buckets.set(key, bucket);
  }
  const chromatic = [...families].filter(([family, area]) => family !== 'neutral' && area >= DETAIL_SHARE * total).sort((a, b) => b[1] - a[1]);
  const top = [...buckets.values()].reduce((best, bucket) => (best === null || bucket.area > best.area ? bucket : best), null);
  return {
    predominant: chromatic[0]?.[0] ?? 'neutral',
    purpleShare: total === 0 ? 0 : (families.get('purple') ?? 0) / total,
    fallback: top === null ? '#64748b' : hex(top.sum.map((value) => value / top.area)),
  };
}

// ---------------------------------------------------------------------------
// Stavba

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const quiet = new Logger(Logger.Verbosity.WARN);
const round = (value, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Primitiva jedné sítě se stejným materiálem a atributy v jedno – `join()` ze
 * `@gltf-transform/functions` skinované uzly přeskakuje. Po zapečení barev je
 * materiál jeden, takže z šesti dílů postavy zbude jedno primitivum.
 */
function joinSkinned(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    const groups = new Map();
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.listTargets().length > 0) continue;
      const layout = primitive.listSemantics().map((semantic) => `${semantic}:${primitive.getAttribute(semantic).getComponentType()}:${primitive.getAttribute(semantic).getType()}`).sort().join(',');
      const key = `${primitive.getMaterial()?.getName()}|${primitive.getMode()}|${primitive.getIndices() !== null}|${layout}`;
      groups.set(key, [...(groups.get(key) ?? []), primitive]);
    }
    for (const primitives of groups.values()) {
      if (primitives.length < 2 || new Set(primitives.map((primitive) => primitive.getMaterial())).size > 1) continue;
      const joined = joinPrimitives(primitives);
      for (const primitive of primitives) {
        mesh.removePrimitive(primitive);
        primitive.dispose();
      }
      mesh.addPrimitive(joined);
    }
  }
}

/**
 * Jedna postava z dokumentu glTF → `{ ok: true, bytes, clips, … }` nebo
 * `{ ok: false, reason }`. Dokument mění na místě.
 */
export async function processDocument(doc, character) {
  doc.setLogger(quiet);
  const root = doc.getRoot();
  const clips = clipMap(root.listAnimations().map((animation) => animation.getName()));
  const missing = missingClips(clips);
  if (missing !== null) return { ok: false, reason: missing };
  const keep = new Set(Object.values(clips));
  for (const animation of root.listAnimations()) {
    if (keep.has(animation.getName())) continue;
    // Samplery přežijí svou animaci a držely by její klíče v souboru – `prune` je nevidí.
    for (const sampler of animation.listSamplers()) sampler.dispose();
    for (const channel of animation.listChannels()) channel.dispose();
    animation.dispose();
  }

  const skin = skinPrimitives(doc, character);
  const textures = await bakeColours(doc);
  let stats = colourStats(await surface(doc, posedPrimitives(doc, clips.idle)));
  if (stats.predominant === 'purple') return { ok: false, reason: `purple is the predominant hue (${Math.round(stats.purpleShare * 100)} % of the surface)` };
  // Fialovou rozhoduje paleta autora: přidaná kůže by přehlasovala fialovou košili (q-bald-man, 21 % plochy).
  if (skin.length > 0) {
    paintSkin(doc, skin, character.id);
    stats = colourStats(await surface(doc, posedPrimitives(doc, clips.idle)));
  }
  const { purpleShare, fallback } = stats;

  await doc.transform(prune(), dedup());
  joinSkinned(doc);
  const source = triangleCount(doc);
  let simplifiedFrom = null;
  if (source > MAX_TRIANGLES) {
    await MeshoptSimplifier.ready;
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: (MAX_TRIANGLES * 0.95) / source, error: 0.01 }));
    simplifiedFrom = source;
  }
  const triangles = triangleCount(doc);
  if (triangles > MAX_TRIANGLES) return { ok: false, reason: `${triangles} triangles over the ${MAX_TRIANGLES} budget after simplification` };
  await doc.transform(resample(), dedup(), prune());

  // Kořen: podstava v y = 0, střed v ose, výška `HEIGHT_M` – v první póze klidu.
  const box = boundsOf(posedPrimitives(doc, clips.idle));
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const scale = HEIGHT_M / Math.max(size.y, 1e-6);
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const rigged = doc.createNode('RiggedRoot').setTranslation([round(-center.x * scale), round(-box.min.y * scale), round(-center.z * scale)]).setScale([round(scale), round(scale), round(scale)]);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    rigged.addChild(child);
  }
  scene.addChild(rigged);
  root.getAsset().generator = 'worldstream scripts/assets/rigged/import-cc0.mjs';

  const bytes = Buffer.from(await io.writeBinary(doc));
  if (bytes.length > MAX_BYTES) return { ok: false, reason: `${bytes.length} bytes over the ${MAX_BYTES} budget` };
  const report = await validator.validateBytes(new Uint8Array(bytes), { uri: `${character.id}.glb`, maxIssues: 50 });
  if (report.issues.numErrors > 0) return { ok: false, reason: `glTF validator: ${report.issues.messages.filter((m) => m.severity === 0).map((m) => m.code).join(', ')}` };
  const dims = [size.x, size.y, size.z].map((value) => Math.round(value * scale * 100) / 100);
  const skinTone = skin.length > 0 ? skinToneOf(character.id) : null;
  return { ok: true, bytes, clips, triangles, simplifiedFrom, textures, dims, fallback, skinTone, purpleShare: Math.round(purpleShare * 1000) / 1000 };
}

/** Postava z cache → výsledek `processDocument` a sha256 zdrojového souboru. */
export async function importCharacter(character, cacheDir = CACHE_DIR) {
  const file = path.join(cacheDir, character.source, ...character.file.split('/'));
  const sourceSha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  const built = await processDocument(await io.read(file), character);
  return { ...built, sourceSha256 };
}

// ---------------------------------------------------------------------------
// Zápis

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

async function main() {
  const cacheDir = flag('--cache') ?? CACHE_DIR;
  const stage = flag('--stage');
  const publicDir = stage ?? path.join(ROOT, 'public');
  const outDir = path.join(publicDir, ...PUBLIC_PREFIX.split('/').filter(Boolean));
  const licenseDir = path.join(publicDir, ...LICENSES.split('/'));
  await mkdir(outDir, { recursive: true });
  await mkdir(licenseDir, { recursive: true });
  // Jen vlastní soubory (`q-*`): ve složce leží i postavy `build.mjs`.
  for (const name of await readdir(outDir)) if (name.startsWith('q-') && name.endsWith('.glb')) await rm(path.join(outDir, name));

  const sources = new Map(JSON.parse(await readFile(path.join(HERE, '..', 'cc0', 'sources.json'), 'utf8')).packs.map((source) => [source.id, source]));
  const characters = [];
  const excluded = [];
  for (const character of CHARACTERS) {
    const built = await importCharacter(character, cacheDir);
    if (!built.ok) {
      excluded.push({ id: character.id, source: `${character.source}/${character.file}`, reason: built.reason });
      console.log(`excluded  ${character.id}  – ${built.reason}`);
      continue;
    }
    await writeFile(path.join(outDir, `${character.id}.glb`), built.bytes);
    const source = sources.get(character.source);
    characters.push({
      id: character.id,
      name: character.name,
      tags: character.tags,
      class: character.class,
      dims: built.dims,
      fallback: built.fallback,
      path: `${PUBLIC_PREFIX}/${character.id}.glb`,
      clips: built.clips,
      triangles: built.triangles,
      simplifiedFrom: built.simplifiedFrom,
      textures: built.textures,
      purpleShare: built.purpleShare,
      ...(built.skinTone === null ? {} : { skinTone: built.skinTone }),
      bytes: built.bytes.length,
      sha256: createHash('sha256').update(built.bytes).digest('hex'),
      license: source.license,
      author: source.author,
      pack: PACK_NAMES[character.source],
      packId: character.source,
      page: source.pageUrl,
      source: `${character.source}/${character.file}`,
      sourceSha256: built.sourceSha256,
    });
    console.log(`built     ${character.id}  ${built.triangles} tris  ${(built.bytes.length / 1024).toFixed(0)} KB  ${Object.keys(built.clips).join(',')}`);
  }

  const packs = [...new Set(characters.map((character) => character.packId))];
  // Text licence s konci řádků LF (`.gitattributes`); licenci, kterou už zapsal `cc0/promote.mjs`, nechá být.
  for (const id of packs) {
    const target = path.join(licenseDir, `${id}.txt`);
    if (existsSync(target)) continue;
    await writeFile(target, (await readFile(path.join(cacheDir, `${id}.license.txt`), 'utf8')).replace(/\r\n/g, '\n'));
  }
  const manifest = {
    $comment:
      'Animované CC0 postavy Quaternius s kostrou a klipy (P54B T3). Generuje scripts/assets/rigged/import-cc0.mjs – needitovat ručně. clips: stav hry → jméno klipu v GLB (idle/walk/run/jump/hit/die/win/shoot); dims v metrech v první póze idle; excluded = vyřazené s důvodem.',
    version: 1,
    characters,
    excluded,
  };
  await writeFile(path.join(ROOT, 'src', 'assets', 'rigged-p54.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${characters.length} characters, ${excluded.length} excluded`);
  if (stage === undefined) await register(characters, packs);
}

/** Položky GLB a licencí balíků v `disclosure.json` a z nich vykreslený `DISCLOSURE.md`. */
async function register(characters, packs) {
  const { renderDisclosure } = await import('../../license-gate.mjs');
  const file = path.join(ROOT, 'disclosure.json');
  const disclosure = JSON.parse(await readFile(file, 'utf8'));
  // Vlastní položky jsou jen GLB `q-*` a zůstanou na svém místě; licenci balíku, kterou už registr má (`cc0/promote.mjs`), nechá být.
  const own = (entry) => entry.kind === 'asset' && entry.name.startsWith(`public${PUBLIC_PREFIX}/q-`);
  const at = disclosure.entries.findIndex(own);
  disclosure.entries = disclosure.entries.filter((entry) => !own(entry));
  disclosure.entries.splice(
    at === -1 ? disclosure.entries.length : at,
    0,
    ...characters.map((character) => ({
      name: `public${character.path}`,
      kind: 'asset',
      firstParty: false,
      reason: `Rigged animated character "${character.name}" for arcade roles (P54B T3); clips reduced to the game states and resampled, material colours baked into vertex colours${character.skinTone ? `, near-black skin recoloured to the natural tone ${character.skinTone}` : ''}, re-rooted on its base at 1.8 m.`,
      source: `${character.pack} – ${character.page} (${character.source})`,
      authorOrProvider: character.author,
      license: character.license,
      requiredNotices: ['žádné — CC0 se vzdává i práva na atribuci'],
      attribution: `${character.name} from ${character.pack} by ${character.author} (${character.license}), ${character.page}`,
      reviewNote: `Pack licence text stored at public/${LICENSES}/${character.packId}.txt; source file sha256 recorded in src/assets/rigged-p54.json by scripts/assets/rigged/import-cc0.mjs.`,
      scope: 'prod',
    })),
  );
  for (const id of packs) {
    const character = characters.find((candidate) => candidate.packId === id);
    if (disclosure.entries.some((entry) => entry.name === `public/${LICENSES}/${id}.txt`)) continue;
    disclosure.entries.push({
      name: `public/${LICENSES}/${id}.txt`,
      kind: 'asset',
      firstParty: false,
      reason: `Licence text shipped with the ${id} pack, kept as evidence for its CC0 models.`,
      source: character.page,
      authorOrProvider: character.author,
      license: character.license,
      requiredNotices: ['none – CC0 waives attribution; credit is given voluntarily in src/assets/rigged-p54.json'],
      attribution: `${id} by ${character.author}, CC0 1.0`,
      reviewNote: 'Covers only CC0 1.0 material; every model it lists has its own disclosure record.',
      scope: 'prod',
    });
  }
  await writeFile(file, `${JSON.stringify(disclosure, null, 2)}\n`);
  await writeFile(path.join(ROOT, 'DISCLOSURE.md'), renderDisclosure(disclosure.entries, disclosure.aiGenerated));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
