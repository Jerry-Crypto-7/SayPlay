/**
 * Kulisa za mlhou (P46G T6). Pinuje se, co by na snímku vypadalo dobře, a přesto
 * bylo špatně: jiné hory při každém načtení hry, kulisa rozsypaná do desítek
 * volání kreslení (telefon), všude tytéž siluety bez ohledu na sadu, světlá
 * kulisa v temném lese a fialová.
 */

import { Color, type HSL, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, type Look, sceneLook } from '@/play/arcade/look';

import { type BackdropLayer, backdropLayers, buildBackdrop, layerAt } from '../backdrop-shapes';

const OPTIONS = { seed: 11, clear: 8, skirt: 0.05 } as const;
const MOODS = ['', 'a dark place', 'a spooky place', 'a stormy place', 'a foggy place', 'a sunny place', 'a place at sunset', 'a place at night'];

const looksIn = (setting: string) => LOOK_IDS.map((id) => [id, sceneLook({ setting, mood: '', look: id })] as const);

/** Obrys na metr poloměru: tvar bez velikosti, kterou dává mlha sady. */
const shapeOf = (layer: BackdropLayer) => layer.profile.map(([angle, height]) => [angle, height / layer.radius]);

/** Svislé hrany (dva body v témž úhlu, jiná výška): panorama domů je má, příroda ne. */
const edgesOf = (layer: BackdropLayer) => layer.profile.filter(([angle, height], i) => i > 0 && angle === layer.profile[i - 1]![0] && height !== layer.profile[i - 1]![1]).length;

/** Kolik výšky obrys na radián nastoupá a sestoupá (na metr poloměru): špičky lesa ano, duny málo. */
const roughnessOf = (layer: BackdropLayer) => layer.profile.reduce((sum, [, height], i) => (i === 0 ? 0 : sum + Math.abs(height - layer.profile[i - 1]![1])), 0) / layer.radius / (2 * Math.PI);

const luminanceOf = (hex: string) => {
  const color = new Color(hex);
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
};

const isPurple = (hex: string) => {
  const hsl: HSL = { h: 0, s: 0, l: 0 };
  new Color(hex).getHSL(hsl, SRGBColorSpace);
  return hsl.h * 360 >= 250 && hsl.h * 360 <= 320 && hsl.s > 0.05;
};

describe('kulisa za mlhou', () => {
  it('tatáž sada a semínko dají tytéž sítě, jiné semínko jiné', () => {
    for (const id of LOOK_IDS) {
      const [first, again] = [buildBackdrop(LOOKS[id], OPTIONS), buildBackdrop(LOOKS[id], OPTIONS)];
      expect(again.map(({ layer }) => layer)).toEqual(first.map(({ layer }) => layer));
      again.forEach(({ geometry }, i) => {
        expect(geometry.getAttribute('position').array).toEqual(first[i]!.geometry.getAttribute('position').array);
        expect(geometry.getAttribute('color').array).toEqual(first[i]!.geometry.getAttribute('color').array);
      });
      const other = backdropLayers(LOOKS[id], OPTIONS.seed + 1, OPTIONS.clear);
      expect(other.map(({ profile }) => profile), id).not.toEqual(first.map(({ layer }) => layer.profile));
    }
  });

  it.each(MOODS)('každá sada má 2–3 vrstvy po jedné síti bez skupin – nejvýš tři volání kreslení (%s)', (setting) => {
    for (const [id, look] of looksIn(setting)) {
      const parts = buildBackdrop(look, OPTIONS);
      expect(parts.length, id).toBeGreaterThanOrEqual(2);
      expect(parts.length, id).toBeLessThanOrEqual(3);
      for (const { geometry } of parts) expect(geometry.groups, id).toEqual([]);
      // Levná pro telefon: pár tisíc trojúhelníků celkem.
      const triangles = parts.reduce((sum, { geometry }) => sum + geometry.getIndex()!.count / 3, 0);
      expect(triangles, id).toBeLessThanOrEqual(3000);
    }
  });

  it('les, poušť a město mají jiné siluety: linie stromů a hory, duny a stolové hory, panorama domů', () => {
    const [forest, desert, city] = (['forest', 'desert', 'city'] as const).map((id) => backdropLayers(LOOKS[id], OPTIONS.seed, OPTIONS.clear));
    expect(forest.map(({ kind }) => kind)).toEqual(['peaks', 'crowns', 'pines']);
    expect(desert.map(({ kind }) => kind)).toEqual(['mesas', 'dunes', 'dunes']);
    expect(city.map(({ kind }) => kind)).toEqual(['blocks', 'blocks']);
    // Tvar, ne jen jméno: obrysy se liší i po odečtení velikosti, kterou dává mlha sady.
    expect(shapeOf(forest[0]!)).not.toEqual(shapeOf(desert[0]!));
    expect(shapeOf(forest[0]!)).not.toEqual(shapeOf(city[0]!));
    expect(shapeOf(desert[0]!)).not.toEqual(shapeOf(city[0]!));
    // Domy mají svislé hrany, les a poušť ne; špičky jehličnanů jsou o hodně členitější než duny.
    expect(city.every((layer) => edgesOf(layer) > 20)).toBe(true);
    expect([...forest, ...desert].map(edgesOf)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(roughnessOf(forest[2]!)).toBeGreaterThan(4 * roughnessOf(desert[2]!));
  });

  it('nejbližší vrstva má nad cestou průsek, vzdálenější ne', () => {
    const layers = backdropLayers(LOOKS.forest, OPTIONS.seed, OPTIONS.clear);
    const peakNear = (layer: BackdropLayer, from: number, to: number) => Math.max(...layer.profile.filter(([angle]) => Math.min(angle, 2 * Math.PI - angle) * layer.radius >= from && Math.min(angle, 2 * Math.PI - angle) * layer.radius <= to).map(([, height]) => height));
    const near = layers[2]!;
    expect(peakNear(near, 0, OPTIONS.clear)).toBeLessThan(0.15 * peakNear(near, 2 * OPTIONS.clear, 6 * OPTIONS.clear));
    expect(peakNear(layers[0]!, 0, OPTIONS.clear)).toBeGreaterThan(0.02 * layers[0]!.radius);
  });

  it('vrstvy stojí v mlze za sebou a bližší jede s kamerou do strany míň (paralaxa)', () => {
    for (const id of LOOK_IDS) {
      const look: Look = LOOKS[id];
      const layers = backdropLayers(look, OPTIONS.seed, OPTIONS.clear);
      for (let i = 1; i < layers.length; i += 1) {
        expect(layers[i]!.radius, id).toBeLessThan(layers[i - 1]!.radius);
        expect(layers[i]!.follow, id).toBeLessThan(layers[i - 1]!.follow);
      }
      for (const layer of layers) {
        expect(layer.radius, id).toBeGreaterThan(look.fog[0]);
        expect(layer.radius, id).toBeLessThan(look.fog[1]);
        // Na konci trati vrstva stojí pořád za začátkem mlhy a s kamerou do strany jede z `follow`.
        const end = layerAt(layer, 10, 400, 400);
        expect(400 - end.z, id).toBeCloseTo(layer.approach);
        expect(layer.radius - layer.approach, id).toBeGreaterThan(look.fog[0]);
        expect(end.x, id).toBeCloseTo(10 * layer.follow);
      }
    }
  });

  it('barvy jdou z mlhy po náladě: siluety tmavší než mlha, temný les temnější než les, nic fialového', () => {
    const purple: string[] = [];
    for (const setting of MOODS) {
      for (const [id, look] of looksIn(setting)) {
        for (const layer of backdropLayers(look, OPTIONS.seed, OPTIONS.clear)) {
          expect(luminanceOf(layer.top), `${id} ${setting}`).toBeLessThanOrEqual(luminanceOf(look.horizon) + 1e-6);
          for (const hex of [layer.top, layer.foot]) if (isPurple(hex)) purple.push(`${id} ${setting} ${hex}`);
        }
      }
    }
    expect(purple).toEqual([]);
    const [day, dark] = ['a forest', 'a dark forest'].map((setting) => backdropLayers(sceneLook({ setting, mood: '' }), OPTIONS.seed, OPTIONS.clear));
    day!.forEach((layer, i) => expect(luminanceOf(dark![i]!.top)).toBeLessThan(0.5 * luminanceOf(layer.top)));
  });
});
