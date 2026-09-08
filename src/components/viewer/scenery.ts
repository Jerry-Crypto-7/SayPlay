import { Box3, Group, InstancedMesh, Matrix4, Mesh, type Material, type Object3D } from 'three';

import { familyById } from '@/geom/families';
import { bakePlacements, compilePlacements, type GeomPlacement } from '@/geom/placements';
import type { GeomProgram } from '@/geom/program';
import { PALETTES, pieceById, repaint, trianglesOf, type Palette } from '@/kit';

import { FILL_RINGS } from './dressing';
import { CELL_SIZE, type GridSize } from './projection';

/**
 * Kulisa — **třetí vrstva scény**, postavená programem geometrie.
 *
 * Do 26. 8. 2026 `src/geom/**` neměl v `src/` jediného volajícího: 994 řádků a
 * čtyři výtvarné rodiny, kterými se chlubí přihláška, produkt nevolal. Scéna
 * přitom stála na 1 940 trojúhelnících ze stropu 120 000, tedy na 1,6 %
 * rozpočtu. Tohle je ta spára.
 *
 * **Kulisa nenahrazuje hratelnou mřížku.** Hrací buňky zůstávají na kitu,
 * protože potřebují per-instance matice a volné sloty pro nošené propy. Kulisa
 * je kus krajiny **za** hrací plochou: program geometrie pracuje v souřadnicích
 * ±64 a o mřížce neví, takže se celá skupina posune tak, aby její nejbližší
 * hrana ležela až za vzdálenou hranou mřížky. Posun se počítá z **naměřeného**
 * obalu, ne z deklarovaných proporcí rodiny — deska terénu je u Hutí 37 polí
 * široká, zatímco `footprint` hlásí 19, a překryv by kulisa položila přes hru.
 *
 * **Kusy se instancují po id, zbytek se zapeče do jedné sítě.** Zrcadlené kusy
 * mají matici se záporným determinantem a `MeshToonMaterial` se `side:
 * FrontSide` by je odřízl jako odvrácené, takže jdou do zapečené sítě spolu se
 * zemí a prosekanými podstromy. Cena je jedno kreslicí volání navíc a správné
 * vinutí, což je lepší obchod než celá kulisa naruby.
 *
 * **Kulisa nevrhá ani nepřijímá stín schválně.** Stínová kamera má dosah 16
 * polí (`Lighting.tsx`) a kulisa začíná až za ním, takže stínový průchod by ji
 * kreslil podruhé a nezískal by tím jediný pixel.
 */

/**
 * Mezera mezi vzdálenou hranou mřížky a nejbližší hranou kulisy, v polích.
 *
 * **Odvozená z hloubky výplně, ne zvolená.** Výplň (`dressing.ts`) staví kusy
 * na `FILL_RINGS` prstencích za mřížkou; kdyby tohle číslo zůstalo 1, ležela by
 * krajina na nich. Jedno pole navrch je ta mezera, kterou tu byla vždycky.
 */
const GRID_MARGIN = FILL_RINGS + 1;

/**
 * Kulisa sedí o vlásek pod pochozí rovinou (`floor` je na −0,06), aby zem
 * rodiny nikde neprorazila podlahu hrací plochy.
 */
const SCENERY_DEPTH = -0.08;

export interface SceneryBuild {
  /** Id rodiny, kterou kulisa postavila. */
  readonly family: string;
  /** Uzel k zavěšení do scény, nebo `null`, když rodina neexistuje. */
  readonly object: Object3D | null;
  /** Kolik kreslicích volání kulisa přidá. Jedna dávka na id kusu plus zapečená síť. */
  readonly drawCalls: number;
  readonly triangles: number;
  readonly dispose: () => void;
}

const EMPTY = (family: string): SceneryBuild => ({
  family,
  object: null,
  drawCalls: 0,
  triangles: 0,
  dispose: () => {},
});

/** Kusy k instancování zvlášť, zbytek k zapečení zvlášť. */
function split(placements: readonly GeomPlacement[]): {
  readonly instanced: ReadonlyMap<string, readonly Matrix4[]>;
  readonly baked: readonly GeomPlacement[];
} {
  const instanced = new Map<string, Matrix4[]>();
  const baked: GeomPlacement[] = [];

  for (const placement of placements) {
    if (placement.kind === 'mesh' || placement.mirrored) {
      baked.push(placement);
      continue;
    }
    const matrices = instanced.get(placement.pieceId);
    if (matrices === undefined) instanced.set(placement.pieceId, [placement.matrix]);
    else matrices.push(placement.matrix);
  }

  return { instanced, baked };
}

/** Hotová skupina z programu, ještě bez posunu za hrací mřížku. */
export interface ProgramBuild {
  readonly object: Group;
  /** Naměřený obal, ne deklarovaný — z něj se počítá posun kulisy. */
  readonly bounds: Box3;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly dispose: () => void;
}

/** Co si volající řídí sám, protože se to mezi kulisou a scénou liší. */
export interface ProgramBuildOptions {
  /**
   * Vrhá a přijímá scéna stín? **Kulisa ne** — leží za dosahem stínové kamery,
   * takže by ji stínový průchod kreslil podruhé bez jediného získaného pixelu.
   * Cílový snímek naopak ano, tam je stín polovina obrazu.
   */
  readonly shadows?: boolean;
  /** Předpona jmen uzlů. Ulehčuje hledání ve scéně i v testech. */
  readonly name?: string;
}

/**
 * Program geometrie → skupina k zavěšení do scény.
 *
 * Vydělené z `buildScenery` 28. 8. 2026, když cílový snímek přestal být ručně
 * psaným `three` a stal se programem: obě cesty musí kusy instancovat, zrcadlené
 * zapékat a přebarvovat paletou **stejně**, jinak by se snímek, na který produkt
 * míří, kreslil jinou cestou než produkt sám.
 *
 * `material` si drží volající — kit má jediný materiál, protože barvu nese
 * geometrie (`vertexColors`), a přebarvuje se paletou (`repaint`).
 */
export function buildProgramGroup(
  program: GeomProgram,
  palette: Palette,
  material: Material,
  options: ProgramBuildOptions = {},
): ProgramBuild {
  return buildPlacementGroup(compilePlacements(program), palette, material, options);
}

/**
 * Hotové kusy → skupina k zavěšení do scény.
 *
 * Vydělené z `buildProgramGroup` 3. 9. 2026 kvůli `WorldstreamStage`. Hrubý
 * svět (`buildProxyWorld`) si kusy zkompiluje sám, protože je musí **rozdělit**
 * mezi sloty a kulisu, takže mu z programu nezbude nic k překompilování — a
 * druhá cesta, jak se kusy dostanou na scénu, je přesně to, co se tady nesmí
 * stát. Kdyby stage instancovala po svém, měl by jeden a týž kus jiný počet
 * kreslicích volání podle toho, kdo ho kreslí.
 */
export function buildPlacementGroup(
  placements: readonly GeomPlacement[],
  palette: Palette,
  material: Material,
  options: ProgramBuildOptions = {},
): ProgramBuild {
  const { instanced, baked } = split(placements);
  const shadows = options.shadows ?? false;
  const name = options.name ?? 'program';

  const group = new Group();
  group.name = name;
  const owned: { dispose: () => void }[] = [];
  const bounds = new Box3();
  let drawCalls = 0;
  let triangles = 0;

  for (const [pieceId, matrices] of instanced) {
    const piece = pieceById(pieceId);
    // Program vybírá kusy z uzavřeného slovníku schématu, takže sem to nemá
    // jak dojít — a kdyby ano, chybí jeden kus kulisy, ne celá scéna.
    if (piece === undefined) continue;

    const geometry = piece.build();
    repaint(geometry, palette);
    geometry.computeBoundingBox();
    owned.push(geometry);

    const mesh = new InstancedMesh(geometry, material, matrices.length);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.frustumCulled = false;
    mesh.name = `${name}:${pieceId}`;
    matrices.forEach((matrix, index) => {
      mesh.setMatrixAt(index, matrix);
      bounds.union(geometry.boundingBox!.clone().applyMatrix4(matrix));
    });
    mesh.instanceMatrix.needsUpdate = true;
    owned.push(mesh);
    group.add(mesh);

    drawCalls += 1;
    triangles += trianglesOf(geometry) * matrices.length;
  }

  if (baked.length > 0) {
    const geometry = bakePlacements(baked);
    repaint(geometry, palette);
    geometry.computeBoundingBox();
    owned.push(geometry);

    const mesh = new Mesh(geometry, material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.frustumCulled = false;
    mesh.name = `${name}:baked`;
    // Prostá síť sama `dispose()` nemá; uvolňuje se její geometrie, ta v `owned` je.
    group.add(mesh);

    bounds.union(geometry.boundingBox!);
    drawCalls += 1;
    triangles += trianglesOf(geometry);
  }

  return {
    object: group,
    bounds,
    drawCalls,
    triangles,
    dispose: () => {
      for (const resource of owned) resource.dispose();
    },
  };
}

/**
 * Postaví kulisu jedné rodiny pro daný svět.
 *
 * Nad `buildProgramGroup` zbývá jediná věc navíc: posun **za** hrací mřížku.
 */
export function buildScenery(
  familyId: string,
  seed: number,
  grid: GridSize,
  material: Material,
): SceneryBuild {
  const family = familyById(familyId);
  // Neznámá rodina je vada výběru, ne stav k vykreslení — kulisa prostě
  // nevznikne. Prázdná hrací plocha je horší vada než chybějící krajina, takže
  // se tu nic nevyhazuje a hra běží dál.
  if (family === undefined) return EMPTY(familyId);

  const built = buildProgramGroup(family.compose(seed), PALETTES[family.palette], material, {
    name: `scenery:${family.id}`,
  });

  // Za mřížku, ne přes ni. Bere se naměřená hrana obalu, takže rodina se
  // širokou deskou se odsune dál než rodina úzká.
  const behind = (grid.height * CELL_SIZE) / 2 + GRID_MARGIN;
  built.object.position.set(0, SCENERY_DEPTH, -(behind + built.bounds.max.z));

  return {
    family: family.id,
    object: built.object,
    drawCalls: built.drawCalls,
    triangles: built.triangles,
    dispose: built.dispose,
  };
}

