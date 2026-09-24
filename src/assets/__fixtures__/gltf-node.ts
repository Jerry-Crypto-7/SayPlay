import { Texture } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * GLTFLoader pro testy v Node: obrázky textur neumí dekódovat (chybí DOM i
 * `createImageBitmap`), takže každou texturu nahradí prázdná `Texture`.
 * Geometrie, uzly a materiály se čtou beze změny; rozměry obrázků hlídá
 * preflight `loader.ts` z hlavičky PNG.
 */
export function parseGlb(bytes: Uint8Array): Promise<GLTF> {
  const loader = new GLTFLoader().register(() => ({ name: 'node-texture-stub', loadTexture: () => Promise.resolve(new Texture()) }));
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer, '');
}
