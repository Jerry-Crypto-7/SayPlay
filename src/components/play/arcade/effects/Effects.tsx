'use client';

/**
 * Spotřebitel sběrnice efektů na plátně (P32-0 T5, P32A T4): částice
 * three.quarks v místě události a otřes kamery po zásahu hráče.
 *
 * Otřes jde na kameru až po tom, co ji scéna umístila: `Effects` je poslední
 * dítě plátna, takže jeho snímek (`useFrame` se stejnou prioritou) běží po
 * snímku scény. Před snímkem scény se posun z minula vrátí (priorita −1),
 * ať scéna, která kameru nestaví každý snímek, otřes nenasčítá. Záporná
 * priorita R3F kreslení nepřebírá.
 *
 * Do stavu hry nic nepíše: čte sběrnici a strop částic bere z úrovně kvality,
 * kterou rig napsal do `data-quality`.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, CanvasTexture, Color, type Mesh, MeshBasicMaterial, NormalBlending, type Object3D, SRGBColorSpace, Vector3 } from 'three';
import {
  ApplyForce,
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ColorRange,
  ConstantValue,
  Gradient,
  HemisphereEmitter,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  Vector3 as QVector3,
  Vector4 as QVector4,
  RenderMode,
  SizeOverLife,
  SphereEmitter,
} from 'three.quarks';

import { HEADER } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';

import { type QualityTier, QUALITY_TIERS } from '../look/rig/quality';
import type { ArcadeSession } from '../session';
import { type EffectsBus, type VisualEventKind, createEffectsBus } from './bus';
import { type Burst, type BurstLook, PARTICLE_CAP, burstsOf, createParticleDirector } from './particles';

declare global {
  interface Window {
    /** Kolik vizuálních událostí sběrnice vydala od připojení plátna, po druzích (T5: e2e čeká na `land`). */
    __playFx?: () => Partial<Record<VisualEventKind, number>>;
  }
}

/** Největší posun kamery při otřesu (m). */
const SHAKE_M = 0.14;

/** Měkká kulatá tečka – jedna textura pro všechny částice. */
function dotTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Průměrná barva prvního viditelného těla s `userData.item === item` (vertex barvy slitého těla, jinak materiál). */
function bodyColorOf(scene: Object3D, item: string): string | null {
  let found: Object3D | null = null;
  scene.traverse((node) => {
    if (found === null && node.visible && node.userData.item === item) found = node;
  });
  if (found === null) return null;
  const sum = new Color(0, 0, 0);
  let count = 0;
  (found as Object3D).traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    const colors = mesh.geometry.getAttribute('color');
    if (colors !== undefined) {
      const step = Math.max(1, Math.floor(colors.count / 64));
      for (let i = 0; i < colors.count; i += step, count += 1) sum.r += colors.getX(i), sum.g += colors.getY(i), sum.b += colors.getZ(i);
    } else if (!Array.isArray(mesh.material) && 'color' in mesh.material && mesh.material.color instanceof Color) {
      sum.add(mesh.material.color);
      count += 1;
    }
  });
  return count === 0 ? null : `#${sum.multiplyScalar(1 / count).getHexString()}`;
}

const quarksColor = (hex: string): QVector4 => {
  const color = new Color(hex);
  return new QVector4(color.r, color.g, color.b, 1);
};

/** Velikost po dobu života: záblesk a obláček rostou, ostatní se ztrácí. */
const SHRINK = new PiecewiseBezier([[new Bezier(1, 0.95, 0.6, 0), 0]]);
const GROW = new PiecewiseBezier([[new Bezier(0.5, 0.9, 1.1, 1.2), 0]]);

export function Effects({ session, look, surface }: { readonly session: ArcadeSession; readonly look: Look; readonly surface: RefObject<HTMLDivElement | null> }) {
  const camera = useThree((three) => three.camera);
  const scene = useThree((three) => three.scene);
  const bus = useRef<EffectsBus | null>(null);
  const offset = useMemo(() => new Vector3(), []);
  const batch = useMemo(() => new BatchedRenderer(), []);
  const materials = useMemo(() => {
    const map = dotTexture();
    return {
      map,
      plain: new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: NormalBlending }),
      glow: new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: AdditiveBlending }),
    };
  }, []);
  useEffect(
    () => () => {
      materials.map.dispose();
      materials.plain.dispose();
      materials.glow.dispose();
    },
    [materials],
  );

  useEffect(() => {
    // Prach dopadu: v zasněžené sadě (čepička na kulisách) sníh, jinak barva země.
    let colors: BurstLook = { collectible: '#fcd34d', debris: look.ground, land: look.terrain?.cap ?? look.ground };
    const spawn = (burst: Burst) => {
      const system = new ParticleSystem({
        duration: 0.2,
        looping: false,
        worldSpace: true,
        startLife: new IntervalValue(burst.life[0], burst.life[1]),
        startSpeed: new IntervalValue(burst.speed[0], burst.speed[1]),
        startSize: new IntervalValue(burst.size[0], burst.size[1]),
        startColor: new ColorRange(quarksColor(burst.colors[0]), quarksColor(burst.colors[1])),
        emissionOverTime: new ConstantValue(0),
        emissionBursts: [{ time: 0, count: new ConstantValue(burst.count), cycle: 1, interval: 0.01, probability: 1 }],
        // Prach a konfety letí nahoru, ostatní do všech stran.
        shape: burst.kind === 'dust' || burst.kind === 'confetti' ? new HemisphereEmitter({ radius: 0.3 }) : new SphereEmitter({ radius: 0.15 }),
        material: burst.glow ? materials.glow : materials.plain,
        renderMode: RenderMode.BillBoard,
        behaviors: [
          new ApplyForce(new QVector3(0, -1, 0), new ConstantValue(burst.gravity)),
          new SizeOverLife(burst.kind === 'flash' || burst.kind === 'puff' ? GROW : SHRINK),
          new ColorOverLife(new Gradient([[new QVector3(1, 1, 1), 0], [new QVector3(1, 1, 1), 1]], [[1, 0], [0, 1]])),
        ],
      });
      system.emitter.position.set(...burst.at);
      scene.add(system.emitter);
      batch.addSystem(system);
      return { dispose: () => system.dispose() };
    };
    const director = createParticleDirector(spawn);
    const created = createEffectsBus(session);
    bus.current = created;
    const tierOf = (): QualityTier => {
      const tier = surface.current?.dataset.quality;
      return (QUALITY_TIERS as readonly string[]).includes(tier ?? '') ? (tier as QualityTier) : 'high';
    };
    const heard: Partial<Record<VisualEventKind, number>> = {};
    const probe = (): Partial<Record<VisualEventKind, number>> => ({ ...heard });
    window.__playFx = probe;
    const offBursts = created.subscribe((events) => {
      for (const event of events) heard[event.kind] = (heard[event.kind] ?? 0) + 1;
      const now = performance.now() / 1000;
      director.update(now);
      // Barva sběratelné věci ze scény, dokud nějaká stojí; pak poslední známá.
      if (events.some((event) => event.kind === 'pickup')) colors = { ...colors, collectible: bodyColorOf(scene, 'coin') ?? colors.collectible };
      director.emit(events.flatMap((event) => burstsOf(event, colors)), now, PARTICLE_CAP[tierOf()]);
    });
    // Restart (tik zpět) zahodí i částice, které ještě letí.
    let seen = session.state()[HEADER.tick] as number;
    const offRestart = session.subscribe(() => {
      const tick = session.state()[HEADER.tick] as number;
      if (tick < seen) director.reset();
      seen = tick;
    });
    const tick = window.setInterval(() => director.update(performance.now() / 1000), 500);
    return () => {
      if (window.__playFx === probe) delete window.__playFx;
      window.clearInterval(tick);
      offRestart();
      offBursts();
      created.dispose();
      director.reset();
      bus.current = null;
    };
  }, [session, look, scene, batch, materials, surface]);

  useFrame(() => {
    camera.position.sub(offset);
    offset.set(0, 0, 0);
  }, -1);

  useFrame((_, delta) => {
    batch.update(delta);
    const shake = bus.current?.shake() ?? 0;
    if (shake === 0 || reducedMotion()) return;
    // Tlumený kmit: směr z doznívání (to jde po ticích), ne z náhody – týž záznam třese stejně.
    offset.set(Math.sin(shake * 37), Math.cos(shake * 53), 0).multiplyScalar(shake * shake * SHAKE_M);
    camera.position.add(offset);
    camera.updateMatrixWorld();
  });

  return <primitive object={batch} />;
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
