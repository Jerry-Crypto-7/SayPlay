'use client';

/**
 * Podlaha arény ve stylu B (P32E T5): hrací plocha podle sady – led zamrzlého
 * jezera, dlažba hradu, písek, tráva, skála – prstenec stěn za hranou
 * (`buildArenaFloor`) a kulisy sady za stěnami ze všech čtyř stran.
 *
 * Vnitřek zdobí drobnosti sady (`buildArenaDecor`, P36C T5) – jedna síť bez
 * fyziky, mimo hrdinu a věci na startu (`keep`), rozmístěná ze semínka hry.
 * Řada kulis na straně kamery (−z, popředí) je nejvýš `FOREGROUND_TALLEST`
 * výšek hrdiny (`hero`), vzdálené řady stojí v plné velikosti.
 *
 * Barvy nesou vrcholy sítě z palety sady; tady žádná barva navíc. Podlaha leží
 * v y = 0 na zemi jádra, stěny i kulisy jsou jen vzhled – jádro o nich neví.
 * `half` v metrech.
 *
 * Sada s vegetací (P46G T7) ji má za stěnami: vzadu a po stranách všechny tři
 * vrstvy, na straně kamery (−z) jen nízké drobnosti – kamera kouká pod 40–62°
 * přes ně na hrdinu u přední hrany. Kulisa za mlhou tu není: tak strmá kamera
 * obzor nikdy nevidí, horní kraj obrazu plní vzdálená linie stromů.
 *
 * Mezi hranou a stěnou stojí prstenec kusů vegetace sady a u předních rohů 2–4
 * shluky (P54B T9, `arenaRingPlaces`): druh je jedna instancovaná síť bez stínu,
 * nejvýš `RING_KINDS` kreslicích volání navíc. Také jen vzhled mimo hrací plochu.
 *
 * Interiér (P62 T3, `Look.interior`) má podlahu z povrchu (dlažba, prkna, kámen, plechy) a místo prstence
 * a zdi z kvádrů stěnu z kulis sady (`interiorWallPlaces`, `InteriorWall`) – regály supermarketu, nábytek
 * obýváku, hradby. Slepý soudce o obchoďáku viděl „řídké béžové prostředí“ s kulisami až daleko na okraji.
 */

import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import { Box3, Group, InstancedMesh, Matrix4, type Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three';

import type { Flora, Look } from '@/play/arcade/look';

import { compileForComposer } from '../../feed/StageHost';
import { loadFlatModel, type PlantModel, paintedPlant, plantMaterial, toonMaterial } from '../look/load';
import { arenaRingPlaces, buildArenaDecor, type DecorKeep, interiorWallPlaces, type RingPiece, ringKindsOf, ringMesh, type WallPiece } from '../look/rig/terrain/arenaDecor';
import { ARENA_WALL_END, buildArenaFloor } from '../look/rig/terrain/arenaFloor';
import { FOREGROUND_TALLEST, Scenery } from '../look/Scenery';
import { VegetationAround } from '../look/Vegetation';
import { LOW_TOWARD_CAMERA } from '../look/vegetation-places';

/** Volný pás vegetace za hranou arény (m): mezera a stěna, pak metr. */
const VEGETATION_CLEAR = ARENA_WALL_END + 1;

export interface ArenaFloorProps {
  readonly look: Look;
  readonly half: number;
  /** Semínko hry: tatáž hra má tutéž výzdobu. */
  readonly seed: number;
  /** Místa těl na startu, kam výzdoba nesmí (m ve scéně). */
  readonly keep: readonly DecorKeep[];
  /** Výška nakresleného hrdiny (m) – strop kulis v popředí. */
  readonly hero: number;
  /** Výzdoba podlahy (kamínky, koberečky, kostičky); agar ji nemá – barevná kostička by tam vypadala jako potrava. */
  readonly decor?: boolean;
}

export function ArenaFloor({ look, half, seed, keep, hero, decor: decorated = true }: ArenaFloorProps) {
  const arena = useMemo(() => buildArenaFloor({ look, half }), [look, half]);
  const decor = useMemo(() => (decorated ? buildArenaDecor({ look, half, seed, keep }) : null), [decorated, look, half, seed, keep]);
  const interior = look.interior !== undefined;
  // Interiér má místo prstence vegetace stěnu z kulis sady; venku je stěna prázdná.
  const ring = useMemo(() => (interior ? [] : [...ringKindsOf(arenaRingPlaces({ look, half, seed, keep }))]), [interior, look, half, seed, keep]);
  const kitWalls = useMemo(() => [...ringKindsOf(interiorWallPlaces({ look, half, seed, keep }))], [look, half, seed, keep]);
  // Led se leskne, dlažba, písek a tráva ne.
  const ground = useMemo(() => new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: look.cover === 'snow' ? 0.45 : 0.9 }), [look.cover]);
  const walls = useMemo(() => new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }), []);
  useEffect(
    () => () => {
      arena.floor.dispose();
      arena.walls.dispose();
    },
    [arena],
  );
  useEffect(() => () => decor?.dispose(), [decor]);
  useEffect(() => () => ground.dispose(), [ground]);
  useEffect(() => () => walls.dispose(), [walls]);
  const box = useMemo(() => ({ x0: -half, x1: half, z0: -half, z1: half }), [half]);
  const flora = look.flora;
  return (
    <>
      {/* Stín jen přijímá: rovná plocha by si vlastní stín kreslila jako akné. `surface` čte test interiéru. */}
      <mesh geometry={arena.floor} material={ground} receiveShadow userData={{ rigShadow: 'receive', terrain: 'arena', surface: arena.surface }} />
      {/* Výzdoba stín nevrhá: stínový průchod by stál další volání za kamínky, které nikdo nehledá. */}
      {decor !== null && <mesh geometry={decor} material={walls} receiveShadow userData={{ rigShadow: 'receive', terrain: 'arena-decor' }} />}
      {!interior && <mesh geometry={arena.walls} material={walls} userData={{ terrain: 'arena-walls' }} />}
      {kitWalls.map(([id, pieces]) => <InteriorWall key={id} id={id} pieces={pieces} />)}
      {flora !== undefined && ring.map(([id, pieces]) => <RingKind key={id} id={id} flora={flora} pieces={pieces} />)}
      {flora !== undefined && <VegetationAround flora={flora} seed={seed} box={box} clear={VEGETATION_CLEAR} layers={LOW_TOWARD_CAMERA} />}
      {[0, Math.PI / 2].map((turn) => (
        <group key={turn} rotation={[0, turn, 0]}>
          {/* Otočená skupina staví stranu +x na −z scény – na stranu kamery. */}
          <Scenery look={look} layout="sides" inner={arena.sceneryInner} from={-arena.sceneryInner} to={arena.sceneryInner} cap={look.terrain?.cap} tallest={turn === 0 ? undefined : { side: 1, height: FOREGROUND_TALLEST * hero }} vegetation />
        </group>
      ))}
    </>
  );
}

/** Jeden druh prstence a shluků: model obarvený jako vegetace sady, všechny kusy v jedné instancované síti. */
function RingKind({ id, flora, pieces }: { readonly id: string; readonly flora: Flora; readonly pieces: readonly RingPiece[] }) {
  const [model, setModel] = useState<PlantModel | null>(null);
  useEffect(() => {
    let live = true;
    void paintedPlant(id, flora).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id, flora]);
  const mesh = useMemo(() => (model === null ? null : ringMesh(pieces, model.geometry, plantMaterial(model.double))), [model, pieces]);
  // Geometrie a materiál patří cache modelů (`paintedPlant`); síť uvolní jen své instance.
  useEffect(() => () => mesh?.dispose(), [mesh]);
  return mesh === null ? null : <primitive object={mesh} />;
}

/**
 * Jeden druh stěny interiéru (P62 T3): model kulisy slitý po materiálech (`loadFlatModel`), každá jeho síť jako
 * instance pro všechny kusy – druh stojí kreslicí volání na materiál. Materiál toon bez větru (vítr má materiál
 * vegetace; hradba v hradu se kývat nesmí), stín jen přijímá jako prstenec.
 */
export function InteriorWall({ id, pieces }: { readonly id: string; readonly pieces: readonly WallPiece[] }) {
  const [model, setModel] = useState<Object3D | null>(null);
  useEffect(() => {
    let live = true;
    void loadFlatModel(id).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const group = useMemo(() => (model === null ? null : wallMeshes(model, pieces)), [model, pieces]);
  // Geometrie a materiály patří cache modelů; skupina uvolní jen své instance.
  useEffect(() => () => group?.children.forEach((mesh) => (mesh as InstancedMesh).dispose()), [group]);
  // Do scény až s přeloženými programy (P62 T11): instancovaná toon stěna přidá hradu tři programy shaderů a jejich
  // první kresba na ně hlavní vlákno čekala – na Pixel 7 s CPU 4× o 0,39 s víc než `main`. Překlad běží mimo něj.
  const get = useThree((three) => three.get);
  const [compiled, setCompiled] = useState<Group | null>(null);
  useEffect(() => {
    if (group === null) return;
    let live = true;
    void compileForComposer(get(), group).then(() => {
      if (live) setCompiled(group);
    });
    return () => {
      live = false;
    };
  }, [get, group]);
  return group === null || compiled !== group ? null : <primitive object={group} />;
}

/** Instance kusů: model vysoký 1 s patou uprostřed v počátku, kus ho natočí, zvětší na svou výšku a postaví. */
function wallMeshes(model: Object3D, pieces: readonly WallPiece[]): Group {
  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const unit = 1 / Math.max(size.y, 1e-3);
  const fit = new Matrix4().makeScale(unit, unit, unit).multiply(new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  const place = new Matrix4();
  const scale = new Vector3();
  const group = new Group();
  model.traverse((node) => {
    const source = node as Mesh;
    if (source.isMesh !== true) return;
    const material = Array.isArray(source.material) ? source.material.map(toonMaterial) : toonMaterial(source.material);
    const mesh = new InstancedMesh(source.geometry, material, pieces.length);
    pieces.forEach((piece, i) => mesh.setMatrixAt(i, place.makeRotationY(piece.turn).scale(scale.setScalar(piece.height)).setPosition(piece.x, 0, piece.z).multiply(fit)));
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData = { rigShadow: 'receive', terrain: 'arena-interior' };
    mesh.computeBoundingSphere();
    group.add(mesh);
  });
  return group;
}
