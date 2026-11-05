/**
 * Opravy modelu při načtení (P71E T2). Na snímku by vypadalo stejně, a přesto bylo špatně:
 * oboustranný trojúhelník, jehož pořadí vrcholů jde proti normálám (three ho stíní jako
 * odvrácený – loď je černá), otočený u sdílené geometrie dvakrát (zpátky špatně), nebo
 * jednostranný otočený (zmizí). Postava s unlit materiálem, která zůstane bez světla a svitu.
 */

import { BufferAttribute, BufferGeometry, Color, DoubleSide, FrontSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Side, Texture, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { litUnlit, rimLit, windAlongNormals } from '../load';

/** Dva trojúhelníky v rovině z = 0, normály vrcholů +z; první je navinutý proti nim, druhý s nimi. */
function sheet(indexed: boolean): BufferGeometry {
  const corners = [
    [0, 0, 0], [0, 1, 0], [1, 0, 0], // proti: (b − a) × (c − a) = −z
    [2, 0, 0], [3, 0, 0], [2, 1, 0], // s nimi: +z
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners.flat()), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(corners.flatMap(() => [0, 0, 1])), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(corners.flatMap((_, i) => [i, 10 * i])), 2));
  if (indexed) geometry.setIndex([0, 1, 2, 3, 4, 5]);
  return geometry;
}

/** Souhlasí geometrická normála každého trojúhelníku s normálami jeho vrcholů? */
function agrees(geometry: BufferGeometry): boolean[] {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const vertex = (k: number) => (geometry.index === null ? k : geometry.index.getX(k));
  const out: boolean[] = [];
  for (let t = 0; t < 2; t += 1) {
    const [a, b, c] = [0, 1, 2].map((n) => new Vector3().fromBufferAttribute(position, vertex(3 * t + n)));
    const face = new Vector3().crossVectors(b!.clone().sub(a!), c!.clone().sub(a!));
    out.push(face.dot(new Vector3().fromBufferAttribute(normal, vertex(3 * t))) > 0);
  }
  return out;
}

const meshOn = (geometry: BufferGeometry, side: Side) => new Mesh(geometry, new MeshStandardMaterial({ side }));

describe('windAlongNormals', () => {
  it.each([true, false])('turns a double-sided triangle wound against its normals (indexed %s)', (indexed) => {
    const geometry = sheet(indexed);
    expect(agrees(geometry)).toEqual([false, true]);
    windAlongNormals(new Group().add(meshOn(geometry, DoubleSide)));
    expect(agrees(geometry)).toEqual([true, true]);
  });

  it('moves every attribute with the vertex it belongs to (non-indexed)', () => {
    const geometry = sheet(false);
    windAlongNormals(new Group().add(meshOn(geometry, DoubleSide)));
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    // Vrcholy 1 a 2 se prohodily: na místě 1 je teď (1, 0, 0) s uv původního vrcholu 2.
    expect([position.getX(1), position.getY(1)]).toEqual([1, 0]);
    expect([uv.getX(1), uv.getY(1)]).toEqual([2, 20]);
    expect([uv.getX(4), uv.getY(4)]).toEqual([4, 40]);
  });

  it('turns a geometry shared by two meshes once, not back', () => {
    const geometry = sheet(true);
    windAlongNormals(new Group().add(meshOn(geometry, DoubleSide), meshOn(geometry, DoubleSide)));
    expect(agrees(geometry)).toEqual([true, true]);
  });

  it('leaves a single-sided mesh alone, where the winding decides what is drawn', () => {
    const geometry = sheet(true);
    windAlongNormals(new Group().add(meshOn(geometry, FrontSide)));
    expect(agrees(geometry)).toEqual([false, true]);
  });
});

describe('litUnlit', () => {
  it('gives an unlit character a lit material with its texture, colour and side, shared as before', () => {
    const map = new Texture();
    const unlit = new MeshBasicMaterial({ map, color: '#c8a040', side: DoubleSide });
    const kept = new MeshStandardMaterial({ color: '#ffffff' });
    const root = new Group().add(new Mesh(sheet(true), unlit), new Mesh(sheet(true), unlit), new Mesh(sheet(true), kept));
    litUnlit(root);
    const [first, second, third] = root.children as Mesh[];
    const lit = first!.material as MeshStandardMaterial;
    expect(lit.type).toBe('MeshStandardMaterial');
    expect(lit.map).toBe(map);
    expect(lit.color.equals(new Color('#c8a040'))).toBe(true);
    expect(lit.side).toBe(DoubleSide);
    expect(second!.material).toBe(lit);
    expect(third!.material).toBe(kept);
    // Se světlem dostane i okrajový svit postav (dřív ho `rimMaterial` přeskočil).
    rimLit(root);
    expect(((root.children[0] as Mesh).material as MeshStandardMaterial).userData.rim).toBe(true);
  });
});
