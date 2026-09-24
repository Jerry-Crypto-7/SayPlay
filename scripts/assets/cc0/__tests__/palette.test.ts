import { Document } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { hueSat, isPurple, loadPalette, recolorDoc, toSrgb } from '../palette.mjs';

const srgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
const linear = (hex: string) => srgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

describe('purple guard', () => {
  it('flags the purple family and lets neighbours through', () => {
    for (const hex of ['#7c3aed', '#8b5cf6', '#a855f7', '#c026d3', '#6d28d9']) expect(isPurple(srgb(hex)), hex).toBe(true);
    for (const hex of ['#2f7fd6', '#1f8a8a', '#c8412f', '#f2a0a8', '#8d8a82', '#e6e0f0']) expect(isPurple(srgb(hex)), hex).toBe(false);
  });

  it('reads hue in degrees and HSV saturation', () => {
    const { hue, sat } = hueSat(srgb('#7c3aed'));
    expect(hue).toBeGreaterThan(250);
    expect(hue).toBeLessThan(270);
    expect(sat).toBeGreaterThan(0.7);
  });
});

describe('project palette', () => {
  it('comes from the Blender game models and holds no purple', () => {
    const palette = loadPalette();
    expect(palette.length).toBeGreaterThanOrEqual(20);
    expect(palette.map((entry: { name: string }) => entry.name)).toContain('teal-cloth');
    for (const entry of palette) expect(isPurple(entry.srgb), entry.name).toBe(false);
  });
});

describe('recolorDoc', () => {
  it('maps every vertex colour onto the palette so no purple survives', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const colours = ['#7c3aed', '#a855f7', '#c026d3', '#3b82f6', '#22c55e', '#ff00ff', '#8000ff', '#ffffff'];
    const opaque = new Float32Array(colours.flatMap(linear));
    const blend = new Float32Array(colours.flatMap((hex) => [...linear(hex), 0.5]));
    const mesh = doc.createMesh();
    for (const [array, type] of [[opaque, 'VEC3'], [blend, 'VEC4']] as const) {
      mesh.addPrimitive(doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(colours.length * 3)).setBuffer(buffer))
        .setAttribute('COLOR_0', doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)));
    }
    const palette = loadPalette();
    recolorDoc(doc, palette);
    const allowed = new Set(palette.map((entry: { srgb: number[] }) => entry.srgb.map((c) => Math.round(c * 255)).join(',')));
    for (const prim of mesh.listPrimitives()) {
      const colour = prim.getAttribute('COLOR_0')!;
      for (let i = 0; i < colour.getCount(); i++) {
        const value = colour.getElement(i, []);
        const out = toSrgb(value);
        expect(isPurple(out), `${colours[i]} → ${out}`).toBe(false);
        expect(allowed.has(out.map((c: number) => Math.round(c * 255)).join(','))).toBe(true);
        if (colour.getElementSize() === 4) expect(value[3]).toBeCloseTo(0.5, 5);
      }
    }
  });
});
