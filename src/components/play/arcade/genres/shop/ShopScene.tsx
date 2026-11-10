'use client';

/**
 * Scéna obchodu se součtem (P83E T3): vpředu pult s pokladnou (`gen3d-checkout-counter`), za ním hrdina a vzadu
 * police s věcmi z věty, po stranách regály z knihovny. Kamera kouká po +z shora jako u třídění, takže x jádra se
 * zrcadlí – místo police 0 leží vlevo. Věci kreslí ze stavu (polohu jim píše ovládání `shop` i jádro, když je hrdina
 * nese); pod věcí na místě kurzoru svítí kroužek, pult krátce zčervená, když věc odmítne (trefa).
 *
 * Cenovky kreslí DOM (`ShopTouch`, čitelné i na 390×844): scéna jim každý snímek zapíše na plochu `data-shop-spots`
 * – na místo police `x,y,stav` (zlomky plátna bodu nad věcí, stav `SHOP_STATE`) oddělené `;` – a `data-shop-tick`
 * (tik nakresleného snímku, pro e2e). Jen obraz – stav ani hash nemění.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, CanvasTexture, type Group, type MeshStandardMaterial, type PerspectiveCamera, SRGBColorSpace, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, HEADER, UNIT, bodyBase, targetStateOf } from '@/play/arcade/contract';
import { type SceneryModel, isSceneryModel, modelHeight } from '@/play/arcade/look';
import { riggedCharacter } from '@/play/arcade/models';
import { KEEP, SHOP_LAYOUT, SHOP_STATE, type ShopSpot, shelfSpot } from '@/play/arcade/pieces/shop-level';

import { renderHeld } from '../../effects/render-feel';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { fitTall, tokenRect } from '../portrait-first';
import { fitWide } from '../sort/SortScene';
import { shopGameOf } from './shop-text';

type ShopSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

const m = (units: number): number => units / UNIT;
/** Kreslená věc (m): o kus větší než tělo, ať je na telefonu vidět. */
const ITEM = 0.85;
const HERO_H = 1.9;
const COUNTER = { w: 4.4, h: m(SHOP_LAYOUT.counterY), d: 1.0 } as const;
/** Police: šíře podle čtyř míst, deska pod každou řadou. */
const SHELF_W = (m(SHOP_LAYOUT.colX) * SHOP_LAYOUT.cols) + 0.4;
const SHELF_D = 1.0;
const BOARD = 0.08;
const SHELF_Z = m(SHOP_LAYOUT.shelfZ);
const COUNTER_Z = m(SHOP_LAYOUT.counterZ);
/** Pozice kamery: pod jakým úhlem kouká na obchod (rad) na výšku a na šířku. */
const PITCH = { tall: 0.78, wide: 0.62 } as const;
/** Co musí být v záběru: od čela pultu po horní polici. */
const BOX = new Box3(new Vector3(-SHELF_W / 2 - 0.2, 0, COUNTER_Z - COUNTER.d / 2 - 0.2), new Vector3(SHELF_W / 2 + 0.2, m(SHOP_LAYOUT.rowY[1]) + ITEM + 0.3, SHELF_Z + SHELF_D / 2));
const LAND = { x0: -30, x1: 30, z0: -30, z1: 45 } as const;
/** Jak dlouho pult svítí po odmítnutí (s). */
const REFUSE_S = 0.45;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

/**
 * Nádoba z věty (P83E T7) na stole místo pultu: model z knihovny (tác je z geometrie), jeho kvádr (m) a jak věci
 * na ní leží – `inner` polovina šíře, do které se položené věci stáhnou, `lift` výška dna nad deskou, `size` zmenšení
 * položené věci. Vozík stojí na zemi místo stolu, jeho koš je ve výšce pultu. Jen obraz – jádro má jedno místo.
 */
const SPOT_LOOK: Readonly<Record<Exclude<ShopSpot, 'counter'>, { readonly model: string | null; readonly w: number; readonly h: number; readonly d: number; readonly inner: number; readonly lift: number; readonly size: number }>> = {
  bowl: { model: 'gen3d-fruit-bowl', w: 2.2, h: 0.7, d: 1.1, inner: 0.45, lift: 0.08, size: 0.7 },
  tray: { model: null, w: 2.6, h: 0.08, d: 1.0, inner: 1.05, lift: 0.06, size: 0.75 },
  basket: { model: 'gen3d-shopping-basket', w: 2.2, h: 0.8, d: 1.1, inner: 0.45, lift: 0.08, size: 0.7 },
  scale: { model: 'gen3d-deli-scale', w: 2.2, h: 1.0, d: 1.1, inner: 0.4, lift: 0.35, size: 0.7 },
  cart: { model: 'shopping-cart', w: 2.6, h: 1.4, d: 1.4, inner: 0.45, lift: 0, size: 0.7 },
};
/** Půlka šíře řady položených věcí na pultu (m) pro `count` věcí (`counterSpot`). */
const rowHalf = (count: number): number => m(((count - 1) * SHOP_LAYOUT.counterSlot) / 2);

/** Jmenovka věci bez modelu (P83E T7): slovo věty na čele krabičky, ať je poznat, co se nosí („ingredient“). */
function nameTexture(name: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = color.sun;
  context.fillRect(0, 0, 256, 256);
  context.strokeStyle = color.ink;
  context.lineWidth = 10;
  context.strokeRect(5, 5, 246, 246);
  context.fillStyle = color.ink;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  let size = 64;
  context.font = `900 ${String(size)}px Roboto, system-ui, sans-serif`;
  while (context.measureText(name).width > 226 && size > 22) {
    size -= 4;
    context.font = `900 ${String(size)}px Roboto, system-ui, sans-serif`;
  }
  context.fillText(name, 128, 128);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Tác z geometrie (knihovna tác nemá): deska s nízkým okrajem. */
function Tray({ w, d }: { readonly w: number; readonly d: number }) {
  const rim = 0.05;
  const high = 0.1;
  return (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, 0.04, d]} />
        <meshStandardMaterial color={color['sky-deep']} roughness={0.45} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={`x${String(side)}`} position={[(side * (w - rim)) / 2, high / 2, 0]} castShadow>
          <boxGeometry args={[rim, high, d]} />
          <meshStandardMaterial color={color['sky-deep']} roughness={0.45} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`z${String(side)}`} position={[0, high / 2, (side * (d - rim)) / 2]} castShadow>
          <boxGeometry args={[w, high, rim]} />
          <meshStandardMaterial color={color['sky-deep']} roughness={0.45} />
        </mesh>
      ))}
    </group>
  );
}

/** Stěna krabice, kterou kamera vidí: kouká shora po +z, takže čelo je stěna −z (pořadí stěn `BoxGeometry`). */
const FRONT_FACE = 5;

/** Neutrální krabička se jmenovkou na čele. */
function NamedBox({ name }: { readonly name: string }) {
  const texture = useMemo(() => nameTexture(name), [name]);
  useEffect(() => () => texture.dispose(), [texture]);
  const side = ITEM * 0.8;
  return (
    <mesh position={[0, side / 2, 0]} castShadow>
      <boxGeometry args={[side, side, side]} />
      {[0, 1, 2, 3, 4, 5].map((face) => (
        <meshStandardMaterial key={face} attach={`material-${String(face)}`} color={face === FRONT_FACE ? color.paper : color.sun} map={face === FRONT_FACE ? texture : null} roughness={0.6} />
      ))}
    </mesh>
  );
}

/** Police s věcmi: dvě desky na bočnicích, zadní stěna. */
function Shelf() {
  const wood = color['cream-deep'];
  return (
    <group position={[0, 0, SHELF_Z]}>
      {SHOP_LAYOUT.rowY.map((y) => (
        <mesh key={y} position={[0, m(y) - BOARD / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[SHELF_W, BOARD, SHELF_D]} />
          <meshStandardMaterial color={wood} roughness={0.8} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[(side * SHELF_W) / 2, 1.2, 0]} castShadow>
          <boxGeometry args={[0.1, 2.4, SHELF_D]} />
          <meshStandardMaterial color={wood} roughness={0.8} />
        </mesh>
      ))}
      <mesh position={[0, 1.2, SHELF_D / 2]} receiveShadow>
        <boxGeometry args={[SHELF_W, 2.4, 0.06]} />
        <meshStandardMaterial color={color.cream} roughness={0.9} />
      </mesh>
    </group>
  );
}

export function ShopScene({ session, cast, surface, scene: look }: ShopSceneProps) {
  const world = session.world;
  const game = useMemo(() => shopGameOf(world), [world]);
  const items = useMemo(() => (game === null ? [] : Array.from({ length: game.count }, (_, slot) => game.first + slot)), [game]);
  const itemModel = cast.things?.item;
  const spotLook = game?.spot === undefined || game.spot === 'counter' ? null : SPOT_LOOK[game.spot];
  const itemGroups = useRef<(Group | null)[]>([]);
  const hero = useRef<Group | null>(null);
  const cursor = useRef<Group | null>(null);
  const counterTop = useRef<MeshStandardMaterial | null>(null);
  const moving = useRef(false);
  const refuse = useRef({ at: -1, left: 0 });
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const probe = useMemo(() => new Vector3(), []);
  const center = useMemo(() => BOX.getCenter(new Vector3()), []);
  const heroRig = riggedCharacter(cast.player);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session) || game === null) return;
    const state = session.state();
    const prev = session.prev();
    const at = (body: number, slot: number): number => lerp(prev[bodyBase(body) + slot] as number, state[bodyBase(body) + slot] as number, alpha);
    const keep = bodyBase(game.keeper);

    // Věci: tam, kam je postavilo ovládání nebo jádro (nesená jde s hrdinou). V nádobě se položené stáhnou k jejímu
    // středu a zmenší – řada pultu by z mísy přetekla.
    const squeeze = spotLook === null ? 1 : Math.min(1, spotLook.inner / Math.max(rowHalf(game.count), 1e-3));
    items.forEach((body, slot) => {
      const group = itemGroups.current[slot];
      if (group === null || group === undefined) return;
      const inside = spotLook !== null && targetStateOf(state, body) === SHOP_STATE.placed;
      const x = -m(at(body, BODY.x)) * (inside ? squeeze : 1);
      group.position.set(x, m(at(body, BODY.y)) + (inside ? spotLook.lift : 0), m(at(body, BODY.z)));
      group.scale.setScalar(inside ? spotLook.size : 1);
    });

    // Kurzor (klávesy): kroužek pod věcí na místě kurzoru, jen dokud leží na polici.
    const chosen = state[keep + KEEP.cursor] as number;
    const onShelf = targetStateOf(state, game.first + chosen) === SHOP_STATE.shelf;
    if (cursor.current !== null) {
      cursor.current.visible = onShelf;
      const spot = shelfSpot(chosen, game.count);
      cursor.current.position.set(-m(spot.x), m(spot.y) + 0.01, m(spot.z));
    }

    // Odmítnutá věc (trefa): pult krátce zčervená.
    const refusedAt = state[keep + KEEP.refusedAt] as number;
    if (refusedAt !== refuse.current.at && (state[keep + KEEP.refused] as number) > 0) refuse.current = { at: refusedAt, left: REFUSE_S };
    refuse.current.left = Math.max(0, refuse.current.left - delta);
    counterTop.current?.color.set(refuse.current.left > 0 ? color.alarm : color['sky-deep']);

    // Hrdina: jde mezi pultem a policí, otočený po směru chůze, stojící čelem ke kameře.
    const player = state[HEADER.player] as number;
    const base = bodyBase(player);
    const dx = (state[base + BODY.x] as number) - (prev[base + BODY.x] as number);
    const dz = (state[base + BODY.z] as number) - (prev[base + BODY.z] as number);
    moving.current = dx !== 0 || dz !== 0;
    if (hero.current !== null) {
      hero.current.position.set(-m(at(player, BODY.x)), 0, m(at(player, BODY.z)));
      if (moving.current) hero.current.rotation.y = Math.atan2(-dx, dz);
      else hero.current.rotation.y = lerp(hero.current.rotation.y, Math.PI, 1 - Math.exp(-8 * delta));
    }

    // Kamera: na výšku obchod v pásu mezi HUD a zónou palce, na šířku celý s mírnějším sklonem.
    const tall = camera.aspect < 1;
    const pitch = tall ? PITCH.tall : PITCH.wide;
    camera.position.copy(center).addScaledVector(probe.set(0, Math.sin(pitch), -Math.cos(pitch)), 20);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const fit = tall ? fitTall(camera, BOX, tokenRect(size.width, size.height)) : { distance: fitWide(camera, BOX, size.width, size.height), shift: 0 };
    camera.position.copy(center).addScaledVector(probe.set(0, Math.sin(pitch), -Math.cos(pitch)), fit.distance);
    camera.lookAt(center);
    if (tall) camera.setViewOffset(size.width, size.height, 0, fit.shift, size.width, size.height);
    else if (camera.view !== null) camera.clearViewOffset();
    camera.updateMatrixWorld();

    // Cenovky pro DOM: bod nad každou věcí ve zlomku plátna a stav věci.
    const host = surface.current;
    if (host === null) return;
    const spots = items
      .map((body, slot) => {
        const group = itemGroups.current[slot];
        if (group === null || group === undefined) return '0,0,0';
        probe.copy(group.position).setY(group.position.y + ITEM + 0.12).project(camera);
        return `${((probe.x + 1) / 2).toFixed(4)},${((1 - probe.y) / 2).toFixed(4)},${String(targetStateOf(state, body))}`;
      })
      .join(';');
    if (host.dataset.shopSpots !== spots) host.dataset.shopSpots = spots;
    host.dataset.shopTick = String(state[HEADER.tick]);
  });

  if (game === null) return null;
  // Kulisa místa věty (kit prostředí, `shop.ts`), jinak regál obchodu; výška jako ve světě, nejvýš jako police.
  const decor = game.decor ?? 'gen3d-bread-rack';
  const decorH = game.decor !== undefined && isSceneryModel(game.decor as SceneryModel) ? Math.min(2.2, modelHeight(game.decor as SceneryModel)) : 2.2;
  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={30} />
      {/* Podlaha obchodu: od pultu po polici. */}
      <mesh position={[0, 0.005, (COUNTER_Z + SHELF_Z) / 2]} receiveShadow>
        <boxGeometry args={[SHELF_W + 4.6, 0.02, SHELF_Z - COUNTER_Z + 3]} />
        <meshStandardMaterial color={color.paper} roughness={0.95} />
      </mesh>
      <Shelf />
      {/* Regály z knihovny po stranách police: místo je poznat jako obchod. */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (SHELF_W / 2 + 1.3), 0, SHELF_Z]} rotation={[0, Math.PI, 0]}>
          <FittedModel id={decor} w={2.0} h={decorH} d={1.0} fallback={color['cream-deep']} />
        </group>
      ))}
      {/* Pult s pokladnou: model z knihovny, věci se kladou na jeho horní hranu. Nádoba z věty (mísa, tác, košík,
          váha) stojí na stole místo pultu, vozík na zemi. Pruh na čele bliká při odmítnutí. */}
      {spotLook === null ? (
        <group position={[0, 0, COUNTER_Z]} rotation={[0, Math.PI, 0]}>
          <FittedModel id="gen3d-checkout-counter" w={COUNTER.w} h={COUNTER.h} d={COUNTER.d} fallback={color['sky-deep']} />
        </group>
      ) : (
        <>
          {game.spot === 'cart' ? null : (
            <mesh position={[0, COUNTER.h / 2, COUNTER_Z]} castShadow receiveShadow>
              <boxGeometry args={[COUNTER.w, COUNTER.h, COUNTER.d]} />
              <meshStandardMaterial color={color['cream-deep']} roughness={0.8} />
            </mesh>
          )}
          <group position={[0, game.spot === 'cart' ? 0 : COUNTER.h, COUNTER_Z]} rotation={[0, Math.PI, 0]} userData={{ item: `shop-${String(game.spot)}` }}>
            {spotLook.model === null ? <Tray w={spotLook.w} d={spotLook.d} /> : <FittedModel id={spotLook.model} w={spotLook.w} h={spotLook.h} d={spotLook.d} fallback={color['sky-deep']} />}
          </group>
        </>
      )}
      {game.spot === 'cart' ? null : (
        <mesh position={[0, COUNTER.h - 0.12, COUNTER_Z - COUNTER.d / 2 - 0.02]}>
          <boxGeometry args={[COUNTER.w * 0.9, 0.1, 0.03]} />
          <meshStandardMaterial
            ref={(material) => {
              counterTop.current = material;
            }}
            color={color['sky-deep']}
          />
        </mesh>
      )}
      <group ref={cursor} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[ITEM * 0.55, ITEM * 0.7, 28]} />
          <meshStandardMaterial color={color.sun} emissive={color.sun} emissiveIntensity={0.5} />
        </mesh>
      </group>
      {items.map((body, slot) => (
        <group
          key={body}
          ref={(group) => {
            itemGroups.current[slot] = group;
          }}
          userData={{ item: 'shop-item' }}
        >
          {itemModel !== undefined ? (
            <group rotation={[0, Math.PI, 0]}>
              <FittedModel id={itemModel} w={ITEM} h={ITEM} d={ITEM} fallback={color.sun} />
            </group>
          ) : game.name !== undefined ? (
            <NamedBox name={game.name} />
          ) : (
            <mesh position={[0, ITEM * 0.4, 0]} castShadow>
              <boxGeometry args={[ITEM * 0.8, ITEM * 0.8, ITEM * 0.8]} />
              <meshStandardMaterial color={color.sun} roughness={0.6} />
            </mesh>
          )}
        </group>
      ))}
      <group ref={hero} position={[0, 0, COUNTER_Z + m(SHOP_LAYOUT.reach)]} rotation={[0, Math.PI, 0]} userData={{ frame: 'hero' }}>
        {heroRig !== undefined ? (
          <RiggedModel character={heroRig} h={HERO_H} clip={() => (moving.current ? 'walk' : 'idle')} fallback={color['sky-deep']} />
        ) : (
          <FittedModel id={cast.player} w={HERO_H * 0.6} h={HERO_H} d={HERO_H * 0.5} fallback={color['sky-deep']} character />
        )}
      </group>
    </>
  );
}
