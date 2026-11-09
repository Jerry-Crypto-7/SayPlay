/**
 * Kulisy v paletě místa (P77 T2). Na snímku by se to poznalo jen jako „trochu jiné barvy“: tón mimo paletu,
 * světlost modelu ztracená (plochý obrys), nebo přebarvený hrdina, který splyne se scénou. Tyhle piny ano.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BoxGeometry, BufferAttribute, Color, DoubleSide, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '@/play/arcade/look';

import { bakePlace } from '../place-paint';
import { oklab, paletteLab, type Rgb, SNAP_KEEP, snapToPalette } from '../rig/toon';

const hueOf = ([, a, b]: Rgb): number => (Math.atan2(b, a) * 180) / Math.PI;
const hueGap = (x: number, y: number): number => Math.abs(((x - y + 540) % 360) - 180);

/** Barva leží na tónu palety: stejný odstín (±2°) a sytost nejvýš jako tón. Šedá (sytost ~0) projde jen na šedém tónu. */
function onPalette(color: Rgb, palette: readonly Rgb[]): boolean {
  const lab = oklab(color);
  const chroma = Math.hypot(lab[1], lab[2]);
  return palette.some((tone) => {
    const toneChroma = Math.hypot(tone[1], tone[2]);
    if (chroma > toneChroma + 1e-3) return false;
    return chroma < 0.01 ? toneChroma < 0.04 : hueGap(hueOf(lab), hueOf(tone)) < 2;
  });
}

/** Deterministické „náhodné“ barvy přes celý rozsah (lineární RGB). */
const samples: Rgb[] = Array.from({ length: 60 }, (_, i) => [((i * 37) % 60) / 60, ((i * 53 + 11) % 60) / 60, ((i * 71 + 29) % 60) / 60]);

describe('place palette (P77 T2)', () => {
  const palette = paletteLab(LOOKS.city.palette);

  it('moves every colour most of the way onto a palette tone, keeps SNAP_KEEP of its own hue and its lightness', () => {
    for (const color of samples) {
      const own = oklab(color);
      const snapped = oklab(snapToPalette(color, palette));
      // Barva leží na úsečce mezi vlastní barvou a některým tónem palety (sytost tónu ztlumená u tmavších barev), SNAP_KEEP od tónu.
      const onLine = palette.some((tone) => {
        const keep = Math.min(1, own[0] / Math.max(tone[0], 1e-3));
        return [1, 2].every((i) => Math.abs(snapped[i]! - ((1 - SNAP_KEEP) * tone[i]! * keep + SNAP_KEEP * own[i]!)) < 0.02);
      });
      expect(onLine, `${color}`).toBe(true);
      expect(snapped[0]).toBeCloseTo(own[0], 1);
    }
    expect(SNAP_KEEP).toBeGreaterThan(0);
    expect(SNAP_KEEP).toBeLessThan(0.5);
  });

  it('a colour already on a palette tone stays on it', () => {
    for (const hex of LOOKS.city.palette) {
      const color = new Color(hex);
      const tone = oklab([color.r, color.g, color.b]);
      const snapped = oklab(snapToPalette([color.r, color.g, color.b], palette));
      expect(onPalette(snapToPalette([color.r, color.g, color.b], palette), palette), hex).toBe(true);
      expect(Math.hypot(snapped[1] - tone[1], snapped[2] - tone[2]), hex).toBeLessThan(0.01);
    }
  });

  it('bakes opaque meshes into one vertex-coloured mesh on palette tones', () => {
    const model = new Group();
    samples.slice(0, 8).forEach((color, index) => {
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: new Color(...color) }));
      mesh.position.x = index * 2;
      model.add(mesh);
    });
    const tinted = new BoxGeometry(1, 1, 1);
    const count = tinted.getAttribute('position').count;
    tinted.setAttribute('color', new BufferAttribute(Float32Array.from({ length: count * 3 }, (_, i) => samples[(i * 7) % samples.length]![i % 3]!), 3));
    model.add(new Mesh(tinted, new MeshStandardMaterial({ vertexColors: true })));
    const glass = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ transparent: true, opacity: 0.5, side: DoubleSide }));
    model.add(glass);

    const baked = bakePlace(model, palette);
    const meshes = baked.children as Mesh[];
    // Neprůhledné kusy jedna síť; průhledné sklo zůstane se svým materiálem.
    expect(meshes).toHaveLength(2);
    expect(meshes.some((mesh) => mesh.material === glass.material)).toBe(true);
    const opaque = meshes.find((mesh) => mesh.material !== glass.material)!;
    const colors = opaque.geometry.getAttribute('color');
    expect(colors.count).toBe(count * 9);
    // Každý vrchol nese tón palety pro některou zdrojovou barvu (`snapToPalette`), žádnou surovou.
    const tint = tinted.getAttribute('color');
    const sources: Rgb[] = [...samples.slice(0, 8), ...Array.from({ length: count }, (_, i): Rgb => [tint.getX(i), tint.getY(i), tint.getZ(i)])];
    const tones = sources.map((color) => snapToPalette(color, palette));
    const near = (a: readonly number[], b: readonly number[]) => a.every((value, k) => Math.abs(value - b[k]!) < 2e-3);
    for (let i = 0; i < colors.count; i += 1) {
      const vertex = [colors.getX(i), colors.getY(i), colors.getZ(i)];
      expect(tones.some((tone) => near(tone, vertex)), `vertex ${i}`).toBe(true);
      expect(sources.some((color) => near(color, vertex)), `vertex ${i} raw`).toBe(false);
    }
    // Zdroj se nemění.
    expect((model.children[0] as Mesh).material).toBeInstanceOf(MeshStandardMaterial);
    expect((model.children[0] as Mesh).geometry.getAttribute('color')).toBeUndefined();
  });

  it.each(LOOK_IDS)('%s carries 6–10 place tones', (id) => {
    const tones = LOOKS[id].palette;
    expect(tones.length).toBeGreaterThanOrEqual(6);
    expect(tones.length).toBeLessThanOrEqual(10);
    for (const tone of tones) expect(tone).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps the hero and the sentence things out of the palette bake', () => {
    // Hrdina, nepřátelé a věci z věty jdou přes `World.tsx` (`loadBodyModel`, `fitModel`); přebarvení je jen v kulisách.
    const world = readFileSync(join(process.cwd(), 'src/components/play/arcade/World.tsx'), 'utf8');
    expect(world).not.toMatch(/place-paint|loadPlaceModel|bakePlace/);
    const scenery = readFileSync(join(process.cwd(), 'src/components/play/arcade/look/Scenery.tsx'), 'utf8');
    expect(scenery).toMatch(/loadPlaceModel\(id, palette\)/);
  });
});
