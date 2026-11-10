'use client';

/**
 * Scéna klikací simulace (P83C T3, `orrery`): věci z věty na drahách kolem středu, v kruhu, v řadě nebo rozházené.
 * Jmenovka (popisek role z věty) je u každé věci od startu (T7: soudce první brány město ani srdce bez jmen nepoznal),
 * `placeTags` ji položí nad, pod nebo vedle věci tak, aby nepřekryla jinou. Klepnutí věc probudí – jmenovka zezlátne,
 * pod věcí se objeví slunečný kroužek a podle věty pak svítí, zrychlí nebo vyroste. Zrychlení a růst píše jádro do
 * stavu (`layoutThings`), scéna jen kreslí polohu, velikost a vlastní točení těla; svit a puls po klepnutí jsou jen obraz.
 *
 * Kamera kouká shora pod strmým úhlem a x jádra se zrcadlí jako u třídění; na výšku je celá deska v pásu mezi HUD
 * a zónou palce (`fitTall`), na šířku `fitWide`. Tvar dává `shapeOf`: budova kvádr se střechou (vždy), jinak model
 * z knihovny, když ho popisek má (`cast.things`), zeleň korunu na kmeni, ostatní kouli v barvě palety se skvrnou, ať
 * je vidět točení; střed (slunce, jádro) je slunečný a svítí.
 *
 * Plocha dostane `data-orrery-things` – pro prst (`OrreryTouch`) i e2e střed každé věci ve zlomku plátna a její
 * poloměr na plátně v px (`x,y,r;…`) –, `data-orrery-tags` (střed jmenovky ve zlomku plátna, šířka a výška v px)
 * a `data-orrery-tick` (tik nakresleného snímku). Stav ani hash nemění.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, CanvasTexture, type Group, type Mesh, MeshBasicMaterial, type MeshStandardMaterial, type PerspectiveCamera, SRGBColorSpace, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { ORRERY, ORRERY_LAYOUT, type OrreryGame, PHASE_FULL, cursorOf, levelOf, orreryExtent, orreryKind } from '@/play/arcade/pieces/orrery';

import { renderHeld } from '../../effects/render-feel';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { FittedModel, type WorldProps } from '../../World';
import { fitTall, tokenRect } from '../portrait-first';
import { fitWide } from '../sort/SortScene';
import { placeTags, shapeOf } from './orrery-look';

const m = (units: number): number => units / UNIT;
/** Barvy věcí z kitu (žádná fialová); střed má slunce. */
const THING_COLORS: readonly string[] = [color.tomato, color['sky-deep'], color['mint-deep'], color.bubblegum, color['sun-deep'], color.sky, color.mint, color['tomato-deep']];
const HUB_COLOR = color.sun;
/**
 * Sklon kamery (rad od vodorovné): strmý, ať jsou dráhy kruhy, ne úzké elipsy. Na výšku strmější – menší rozdíl hloubky
 * mezi blízkým a vzdáleným okrajem desky, tedy větší věci na úzkém plátně.
 */
const PITCH = { tall: 1.35, wide: 1.0 } as const;
/** Jak vysoko věci plují nad zemí (m). */
const FLOAT = 0.3;
/** Jmenovka: výška karty na plátně (px); mezeru a místo kolem věci dává `placeTags`. */
const TAG_PX = 28;
/** Plátno jmenovky (px textury). */
const TAG_H = 96;
const TAG_W = 640;
/** Puls po klepnutí: délka (s) a výška. */
const PULSE_S = 0.35;
const PULSE = 0.35;
/** Svit (`glow`): síla na stupeň. */
const GLOW = 0.45;
/**
 * Místo pro jmenovku nad nejvyšší věcí v záběru (m), jen na šířku: tam je záběr omezený výškou. Na výšku je nad deskou
 * volno a vyšší krabice by blízké horní rohy přiblížila kameře – deska by se zmenšila (cíle pod 44 px).
 */
const TAG_ROOM = 1.4;

type OrrerySceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

interface Tag {
  readonly texture: CanvasTexture;
  readonly material: MeshBasicMaterial;
  readonly aspect: number;
}

/** Jmenovka: karta kitu (papír, inkoustový okraj) s textem z věty; šířka podle textu. */
function makeTag(text: string): Tag {
  const canvas = document.createElement('canvas');
  const font = '700 56px Roboto, system-ui, sans-serif';
  const measure = canvas.getContext('2d');
  if (measure !== null) measure.font = font;
  const width = Math.min(TAG_W, Math.ceil(measure?.measureText(text).width ?? TAG_W) + 56);
  canvas.width = width;
  canvas.height = TAG_H;
  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = color.paper;
    context.strokeStyle = color.ink;
    context.lineWidth = 6;
    context.beginPath();
    context.roundRect(3, 3, width - 6, TAG_H - 6, 28);
    context.fill();
    context.stroke();
    context.font = font;
    context.fillStyle = color.ink;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, width / 2, TAG_H / 2 + 3, width - 40);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true, depthTest: false, depthWrite: false });
  return { texture, material, aspect: width / TAG_H };
}

/** Kusy jedné věci, které scéna každý snímek posouvá. */
interface ThingParts {
  group: Group | null;
  spinner: Group | null;
  body: MeshStandardMaterial | null;
  halo: Mesh | null;
  ring: Mesh | null;
  tag: Mesh | null;
}

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

interface ShapeProps {
  readonly tint: string;
  readonly onBody: (material: MeshStandardMaterial | null) => void;
}

/** Budova (P83C T7): krémové zdi, střecha v barvě palety, dveře a dvě okna na straně ke kameře (−z). */
function ThingBuilding({ tint, onBody }: ShapeProps) {
  return (
    <>
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[0.9, 0.6, 0.9]} />
        <meshStandardMaterial ref={onBody} color={color.cream} emissive={color.sun} emissiveIntensity={0} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.8, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[0.68, 0.4, 4]} />
        <meshStandardMaterial color={tint} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.15, -0.455]}>
        <boxGeometry args={[0.18, 0.3, 0.02]} />
        <meshStandardMaterial color={color.ink} roughness={0.8} />
      </mesh>
      {[-0.27, 0.27].map((x) => (
        <mesh key={x} position={[x, 0.4, -0.455]}>
          <boxGeometry args={[0.16, 0.14, 0.02]} />
          <meshStandardMaterial color={color.sky} roughness={0.4} />
        </mesh>
      ))}
    </>
  );
}

/** Zeleň bez modelu (park, strom): koruna na kmeni. */
function ThingTree({ onBody }: Omit<ShapeProps, 'tint'>) {
  return (
    <>
      <mesh position={[0, 0.18, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.11, 0.36, 10]} />
        <meshStandardMaterial color={color['ink-soft']} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.66, 0]} castShadow>
        <sphereGeometry args={[0.36, 20, 14]} />
        <meshStandardMaterial ref={onBody} color={color['mint-deep']} emissive={color['mint-deep']} emissiveIntensity={0} roughness={0.7} />
      </mesh>
    </>
  );
}

/** Věc bez modelu: koule v barvě palety a skvrna, na které je vidět točení. */
function ThingBall({ tint, hub, onBody }: ShapeProps & { readonly hub: boolean }) {
  return (
    <>
      <mesh position={[0, 0.5, 0]} castShadow>
        <sphereGeometry args={[0.5, 32, 20]} />
        <meshStandardMaterial ref={onBody} color={tint} emissive={tint} emissiveIntensity={hub ? 0.55 : 0} roughness={0.55} />
      </mesh>
      {!hub && (
        <mesh position={[0.36, 0.72, 0.18]}>
          <sphereGeometry args={[0.13, 12, 8]} />
          <meshStandardMaterial color={color.paper} roughness={0.6} />
        </mesh>
      )}
    </>
  );
}

export function OrreryScene({ session, cast, surface, scene: look, names }: OrrerySceneProps) {
  const world = session.world;
  const game = world.control.params as unknown as OrreryGame;
  const models = useMemo(() => Array.from({ length: game.count }, (_, index) => cast.things?.[orreryKind(index)]), [cast, game]);
  const shapes = useMemo(() => models.map((model, index) => shapeOf(names?.[orreryKind(index)], model !== undefined)), [models, names]);
  const tags = useMemo(() => Array.from({ length: game.count }, (_, index) => {
    const text = names?.[orreryKind(index)];
    return text === undefined ? null : makeTag(text);
  }), [names, game]);
  // Jmenovky na plátně (T7): věci a rozměry jmenovek tohoto snímku, místo z minulého (`placeTags`).
  const onScreen = useMemo(() => Array.from({ length: game.count }, () => ({ x: 0, y: 0, r: 0 })), [game]);
  const tagSizes = useMemo(() => tags.map((tag) => ({ w: tag === null ? 0 : TAG_PX * tag.aspect, h: tag === null ? 0 : TAG_PX })), [tags]);
  const perPxOf = useMemo(() => new Array<number>(game.count).fill(0), [game]);
  const liftOf = useMemo(() => new Array<number>(game.count).fill(0), [game]);
  const tagChoice = useRef<number[]>([]);
  useEffect(() => () => {
    for (const tag of tags) {
      tag?.texture.dispose();
      tag?.material.dispose();
    }
  }, [tags]);
  const extent = m(orreryExtent(game));
  const tallest = useMemo(() => Math.max(...game.things.map((thing) => m(thing.size))) * (game.answer === 'bigger' ? (5 + ORRERY.maxLevel) / 5 : 1), [game]);
  const boxes = useMemo(() => {
    const of = (room: number) => new Box3(new Vector3(-extent, 0, -extent), new Vector3(extent, FLOAT + tallest + room, extent));
    return { tall: of(0), wide: of(TAG_ROOM) };
  }, [extent, tallest]);
  const center = useMemo(() => new Vector3(), []);
  // Země i za okraji záběru na šířku (16 : 9 vidí do stran víc než deska).
  const land = useMemo(() => ({ x0: -extent - 40, x1: extent + 40, z0: -extent - 20, z1: extent + 40 }), [extent]);
  const orbits = useMemo(() => {
    if (game.layout === 'ring') return [m(ORRERY_LAYOUT.ringRadius)];
    if (game.layout !== 'orbit') return [];
    return [...new Set(game.things.filter((thing) => thing.shell >= 0).map((thing) => thing.shell))].map((shell) => m(ORRERY_LAYOUT.shellRadius[shell] as number));
  }, [game]);

  const parts = useRef<ThingParts[]>(Array.from({ length: game.count }, () => ({ group: null, spinner: null, body: null, halo: null, ring: null, tag: null })));
  const shown = useRef<number[]>(new Array<number>(game.count).fill(0));
  const pulses = useRef<number[]>(new Array<number>(game.count).fill(0));
  const cursor = useRef<Mesh | null>(null);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const probe = useMemo(() => new Vector3(), []);
  const edge = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  const up = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();

    // Kamera: celá deska v záběru, na výšku v pásu mezi HUD a zónou palce.
    const tall = camera.aspect < 1;
    const pitch = tall ? PITCH.tall : PITCH.wide;
    const box = tall ? boxes.tall : boxes.wide;
    box.getCenter(center);
    camera.position.copy(center).addScaledVector(probe.set(0, Math.sin(pitch), -Math.cos(pitch)), 20);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const fit = tall ? fitTall(camera, box, tokenRect(size.width, size.height)) : { distance: fitWide(camera, box, size.width, size.height), shift: 0 };
    camera.position.copy(center).addScaledVector(probe.set(0, Math.sin(pitch), -Math.cos(pitch)), fit.distance);
    camera.lookAt(center);
    if (tall) camera.setViewOffset(size.width, size.height, 0, fit.shift, size.width, size.height);
    else if (camera.view !== null) camera.clearViewOffset();
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);

    const started = (state[HEADER.tick] as number) > 0;
    const focus = cursorOf(state, state[HEADER.player] as number);
    const spots: string[] = [];
    game.things.forEach((_thing, index) => {
      const part = parts.current[index] as ThingParts;
      const base = bodyBase(game.first + index);
      const x = -m(lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha));
      const z = m(lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha));
      const s = m(lerp(prev[base + BODY.w] as number, state[base + BODY.w] as number, alpha));
      const level = levelOf(state, game, index);
      if (level > (shown.current[index] as number)) pulses.current[index] = PULSE_S;
      shown.current[index] = level;
      const pulse = pulses.current[index] as number;
      if (pulse > 0) pulses.current[index] = Math.max(0, pulse - delta);
      const swell = pulse > 0 ? 1 + PULSE * Math.sin(Math.PI * (1 - pulse / PULSE_S)) : 1;

      part.group?.position.set(x, 0, z);
      if (part.spinner !== null) {
        part.spinner.position.y = FLOAT;
        part.spinner.scale.setScalar(s * swell);
        // Budova se netočí, jen když věta chce rychlejší (točení je pak odpověď na klepnutí).
        const turns = shapes[index] !== 'building' || game.answer === 'faster';
        part.spinner.rotation.y = turns ? -((state[base + BODY.aux0] as number) / PHASE_FULL) * Math.PI * 2 : 0;
      }
      const hub = game.hub && index === 0;
      if (part.body !== null) part.body.emissiveIntensity = (hub ? 0.55 : 0) + (game.answer === 'glow' ? GLOW * level : 0);
      if (part.halo !== null) {
        part.halo.visible = game.answer === 'glow' && level > 0;
        part.halo.position.y = FLOAT + s / 2;
        part.halo.scale.setScalar(s * swell * (1.25 + 0.12 * level));
        (part.halo.material as MeshBasicMaterial).opacity = 0.12 + 0.08 * level;
      }
      if (part.ring !== null) {
        part.ring.visible = level > 0;
        part.ring.scale.setScalar(s);
      }

      // Na plátně: střed a poloměr věci (px); z nich velikost jmenovky, ať má na každém plátně stejnou výšku.
      probe.set(x, FLOAT + s / 2, z);
      edge.copy(probe).addScaledVector(right, s / 2);
      probe.project(camera);
      edge.project(camera);
      const radius = Math.max(1, Math.hypot(((edge.x - probe.x) / 2) * size.width, ((edge.y - probe.y) / 2) * size.height));
      spots.push(`${((probe.x + 1) / 2).toFixed(4)},${((1 - probe.y) / 2).toFixed(4)},${radius.toFixed(1)}`);
      const seen = onScreen[index] as { x: number; y: number; r: number };
      seen.x = ((probe.x + 1) / 2) * size.width;
      seen.y = ((1 - probe.y) / 2) * size.height;
      seen.r = radius * swell;
      perPxOf[index] = s / 2 / radius;
      liftOf[index] = s / 2;
      // Jmenovka je vidět od startu (T7); probuzená věc ji má ve slunečné barvě.
      const tag = tags[index];
      if (tag !== null && tag !== undefined) tag.material.color.set(level > 0 ? HUB_COLOR : color.paper);
      if (index === focus && cursor.current !== null) {
        cursor.current.visible = started;
        cursor.current.position.set(x, 0.03, z);
        cursor.current.scale.setScalar(s);
      }
    });

    // Jmenovky všech věcí naráz: každá na místě, kde nepřekryje jinou jmenovku ani věc, v pásu mezi HUD a palcem.
    const placedTags = placeTags(onScreen, tagSizes, tokenRect(size.width, size.height), tagChoice.current);
    tagChoice.current = placedTags.choice;
    const tagSpots: string[] = [];
    placedTags.rects.forEach((rect, index) => {
      const part = parts.current[index] as ThingParts;
      const tag = tags[index];
      if (part.tag === null || tag === null || tag === undefined) return;
      const perPx = perPxOf[index] as number;
      const seen = onScreen[index] as { x: number; y: number };
      const h = TAG_PX * perPx;
      // Posun na plátně (osy kamery), ne ve světě: shora by svislý posun jmenovku položil na věc.
      part.tag.visible = true;
      part.tag.position.set(0, FLOAT + (liftOf[index] as number), 0).addScaledVector(right, (rect.x - seen.x) * perPx).addScaledVector(up, (seen.y - rect.y) * perPx);
      part.tag.scale.set(h * tag.aspect, h, 1);
      part.tag.quaternion.copy(camera.quaternion);
      tagSpots.push(`${(rect.x / size.width).toFixed(4)},${(rect.y / size.height).toFixed(4)},${rect.w.toFixed(1)},${rect.h.toFixed(1)}`);
    });

    const host = surface.current;
    if (host === null) return;
    const placed = spots.join(';');
    if (host.dataset.orreryThings !== placed) host.dataset.orreryThings = placed;
    const labelled = tagSpots.join(';');
    if (host.dataset.orreryTags !== labelled) host.dataset.orreryTags = labelled;
    host.dataset.orreryTick = String(state[HEADER.tick]);
  });

  return (
    <>
      <FieldGround look={look} area={land} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={extent + 14} />
      {orbits.map((radius) => (
        <mesh key={`orbit-${radius}`} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[radius - 0.05, radius + 0.05, 128]} />
          <meshBasicMaterial color={color.cream} toneMapped={false} />
        </mesh>
      ))}
      <mesh ref={cursor} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.78, 0.9, 40]} />
        <meshBasicMaterial color={color.ink} toneMapped={false} />
      </mesh>
      {game.things.map((_thing, index) => {
        const hub = game.hub && index === 0;
        const tint = hub ? HUB_COLOR : (THING_COLORS[index % THING_COLORS.length] as string);
        const model = models[index];
        const part = parts.current[index] as ThingParts;
        const tag = tags[index];
        return (
          <group key={index} ref={(group) => void (part.group = group)} userData={{ item: orreryKind(index) }}>
            <group ref={(group) => void (part.spinner = group)}>
              {shapes[index] === 'model' ? (
                <FittedModel id={model as string} w={1} h={1} d={1} fallback={tint} />
              ) : shapes[index] === 'building' ? (
                <ThingBuilding tint={tint} onBody={(material) => void (part.body = material)} />
              ) : shapes[index] === 'tree' ? (
                <ThingTree onBody={(material) => void (part.body = material)} />
              ) : (
                <ThingBall tint={tint} hub={hub} onBody={(material) => void (part.body = material)} />
              )}
            </group>
            <mesh ref={(mesh) => void (part.halo = mesh)} visible={false}>
              <sphereGeometry args={[0.5, 24, 16]} />
              <meshBasicMaterial color={HUB_COLOR} transparent opacity={0.2} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh ref={(mesh) => void (part.ring = mesh)} position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
              <ringGeometry args={[0.6, 0.74, 40]} />
              <meshBasicMaterial color={HUB_COLOR} toneMapped={false} />
            </mesh>
            {tag !== null && tag !== undefined && (
              <mesh ref={(mesh) => void (part.tag = mesh)} material={tag.material} renderOrder={10} visible={false} userData={{ item: 'orrery-tag' }}>
                <planeGeometry args={[1, 1]} />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}
