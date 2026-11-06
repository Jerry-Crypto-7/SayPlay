import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { parseGlb } from '@/assets/__fixtures__/gltf-node';
import { LOOK_IDS } from '@/play/arcade/look';
import { modelPath } from '@/play/arcade/models';
import { OBSTACLE_KINDS } from '@/play/arcade/pieces/runner';

import obstacleKits from '../obstacle-kits.json';

/**
 * Díly prostředí místo šedých kvádrů (P56B T10): každá sada má pro každou překážku běžce a pro plot
 * arény model, který leží v `public/` a nemá licenci CC BY-ND (díl se vepisuje a přebarvuje).
 */
const ROOT = process.cwd();
const disclosure = JSON.parse(readFileSync(join(ROOT, 'disclosure.json'), 'utf8')) as { entries: { name: string; license?: string }[] };
const licenseOf = new Map(disclosure.entries.map((entry) => [entry.name, entry.license]));
const kits = obstacleKits.kits as Readonly<Record<string, Readonly<Record<string, string>>>>;
const KINDS = [...OBSTACLE_KINDS, 'block'] as const;

/**
 * Plot defense a arény i zeď rozcestí je řada dílu `block` čelem ke kameře, slunce z boku: svislá plocha
 * dostane polovinu přímého světla. Hrad měl zříceninu `gen3d-castle-ruin-wall` (šedá 0,157 lineárně) a řada
 * na telefonu četla jako černí rytíři (P71E T2b). Spodní mez průměrné barvy dílu v lineárním RGB – jen pro hrad:
 * tmavé skály pláže nebo sopky čtou jako skály a texturu (pohovka) tahle míra nevidí.
 */
const BLOCK_ALBEDO = 0.2;

/** Průměrný jas barvy modelu (materiál × barva vrcholů), vážený počtem vrcholů. */
async function albedoOf(file: string): Promise<number> {
  const gltf = await parseGlb(readFileSync(join(ROOT, file)));
  let sum = 0;
  let count = 0;
  gltf.scene.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
    const vertices = mesh.geometry.getAttribute('position').count;
    const colors = material.vertexColors ? mesh.geometry.getAttribute('color') : undefined;
    let tint = 1;
    if (colors !== undefined) {
      let total = 0;
      for (let i = 0; i < colors.count; i += 1) total += 0.2126 * colors.getX(i) + 0.7152 * colors.getY(i) + 0.0722 * colors.getZ(i);
      tint = total / colors.count;
    }
    sum += vertices * tint * (0.2126 * material.color.r + 0.7152 * material.color.g + 0.0722 * material.color.b);
    count += vertices;
  });
  return sum / count;
}

describe('obstacle kits', () => {
  it('cover exactly the 18 sets', () => {
    expect(Object.keys(kits).sort()).toEqual([...LOOK_IDS].sort());
  });

  it('castle block is a light wall, not the dark castle ruin read as knights (P71E T2b)', async () => {
    expect(await albedoOf(`public${modelPath(kits.castle!.block!)}`), kits.castle!.block).toBeGreaterThanOrEqual(BLOCK_ALBEDO);
  });

  for (const look of LOOK_IDS) {
    it(`${look} has a model for every obstacle kind and the arena block`, () => {
      for (const kind of KINDS) expect(kits[look]?.[kind], `${look} ${kind}`).toMatch(/\S/);
    });

    it(`${look} models exist in public/ and none is CC BY-ND`, () => {
      for (const kind of KINDS) {
        const file = `public${modelPath(kits[look]![kind]!)}`;
        expect(existsSync(join(ROOT, file)), `${look} ${kind}: ${file}`).toBe(true);
        const license = licenseOf.get(file);
        expect(license, `${look} ${kind}: ${file} has no disclosure entry`).toBeDefined();
        expect(license, `${look} ${kind}: ${file}`).not.toMatch(/\bND\b|NoDerivatives/i);
      }
    });
  }
});
