/**
 * Rekurzivní úklid podstromu scény.
 *
 * Přepnutí světa musí po sobě uklidit **všechno**, co drží paměť na GPU:
 * geometrii, materiál a každou texturu, kterou materiál nese. Oracle úlohy
 * je `renderer.info.memory` po padesáti přepnutích, ne to, že `dispose()`
 * byl zavolán — jednorázový úklid projde i implementaci, která zapomene na
 * textury, a projeví se to až u šestého promptu.
 *
 * ## Textury se HLEDAJÍ, nevyjmenovávají
 *
 * Ruční seznam slotů (`map`, `normalMap`, `roughnessMap`, …) je přesně ta
 * implementace, kterou padesát přepnutí odhalí: three přidá v další verzi slot
 * navíc, seznam o něm neví a textura přežije. Projdou se proto **vlastní
 * hodnoty materiálu** a odloží se cokoli, co se hlásí jako textura —
 * plus uniformy `ShaderMaterial`, kde textura sedí o úroveň hlouběji.
 *
 * ## Sdílený zdroj se odkládá právě jednou
 *
 * Kit vydává jeden materiál na celou scénu (`kitMaterial()`), takže bez
 * deduplikace by jeden materiál přišel na řadu tolikrát, kolik je kusů.
 * `dispose()` je v three idempotentní, ale sčítání by lhalo — a součet je to,
 * co test čte.
 */

import type { BufferGeometry, Material, Object3D, Texture } from 'three';

export interface DisposalTally {
  readonly geometries: number;
  readonly materials: number;
  readonly textures: number;
}

/**
 * Nula odložených zdrojů.
 *
 * Existuje proto, aby volající, který **nic neodkládal**, vracel součet místo
 * `null`. `RepresentationRegistry` (T18) odkládá po každé výměně podoby a
 * občas nemá co — a `null` v tom součtu by znamenalo dvě různá „nic":
 * „neodložilo se" a „ta cesta se nespustila".
 */
export const EMPTY_TALLY: DisposalTally = { geometries: 0, materials: 0, textures: 0 };

/**
 * Součet dvou účtů. Slot po slotu, ne po celé scéně naráz.
 *
 * ⚠ **Sčítá se, nesjednocuje.** Dva `disposeSubtree()` nad týmž objektem by
 * dohromady daly dvojnásobek, protože deduplikace platí uvnitř jednoho volání.
 * Je to schválně: „odloženo právě jednou" se má hlídat tam, kde se rozhoduje,
 * co odejde, a součet je to jediné, co takovou chybu ukáže.
 */
export function addTallies(left: DisposalTally, right: DisposalTally): DisposalTally {
  return {
    geometries: left.geometries + right.geometries,
    materials: left.materials + right.materials,
    textures: left.textures + right.textures,
  };
}

/** Jen to z `Object3D`, na co úklid sahá. Mesh, Line, Points i Sprite to splňují. */
interface Renderable extends Object3D {
  geometry?: BufferGeometry;
  material?: Material | Material[];
}

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null && (value as { isTexture?: unknown }).isTexture === true;
}

/** Textury materiálu: vlastní hodnoty plus `uniforms.<name>.value` u shaderů. */
function texturesOf(material: Material): Texture[] {
  const found: Texture[] = [];

  for (const value of Object.values(material)) {
    if (isTexture(value)) found.push(value);
  }

  const uniforms = (material as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
  if (uniforms !== undefined) {
    for (const uniform of Object.values(uniforms)) {
      if (isTexture(uniform?.value)) found.push(uniform.value);
    }
  }

  return found;
}

function materialsOf(object: Renderable): Material[] {
  if (object.material === undefined) return [];
  return Array.isArray(object.material) ? object.material : [object.material];
}

/**
 * Odloží celý podstrom a vrátí, kolik zdrojů se skutečně odložilo.
 *
 * Kořen se odpojí od rodiče a strom se rozpojí — jinak by scéna, kterou React
 * už nevykresluje, pořád držela referenci na každý mesh v ní.
 */
export function disposeSubtree(root: Object3D): DisposalTally {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();

  root.traverse((object) => {
    const renderable = object as Renderable;
    if (renderable.geometry !== undefined) geometries.add(renderable.geometry);
    for (const material of materialsOf(renderable)) {
      materials.add(material);
      for (const texture of texturesOf(material)) textures.add(texture);
    }
  });

  // Pořadí je textury → materiály → geometrie: materiál po `dispose()` pořád
  // drží odkaz na texturu, takže opačné pořadí by nic nerozbilo, ale čtení
  // uniformů po odložení materiálu je zbytečná otázka na mrtvý objekt.
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();

  root.removeFromParent();
  detach(root);

  return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}

/** Rozpojí strom zdola nahoru, aby na sebe uzly nedržely odkaz. */
function detach(object: Object3D): void {
  for (const child of [...object.children]) detach(child);
  object.clear();
}
