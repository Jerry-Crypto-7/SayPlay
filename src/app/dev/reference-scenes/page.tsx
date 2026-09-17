'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Mesh, PointLight, PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import WorldstreamStage from '@/components/viewer/WorldstreamStage';
import WorldstreamLighting, { WORLDSTREAM_GL, WORLDSTREAM_SHADOWS } from '@/components/viewer/WorldstreamLighting';
import { clayMaterial } from '@/components/viewer/ClayMaterial';
import { createMeshClient } from '@/shape/mesh-client';
import { buildProxyWorldFrom, type ProxyWorld } from '@/worldstream/proxy';
import { referenceCameraAt } from '@/worldstream/framing';
import { REFERENCE_SCENES, referenceBlueprint, type ReferenceScene, type Surface, type Ablation } from '../../../../evals/worldstream/world-quality/reference-scenes/scenes';

interface ReferenceProbe { time: number; camera: number[]; lights: number; triangles: number; calls: number; lampOn: boolean; lampIntensity: number; environment: boolean; shadows: boolean; meshes: number; shadowCasters: number }
declare global { interface Window { __referenceScene?: ReferenceProbe } }

function Piece({ piece }: { piece: Surface }) {
  return <mesh name={`reference:${piece.id}`} position={[...piece.at]} rotation={piece.rotation ? [...piece.rotation] : undefined}
    scale={piece.kind === 'sphere' ? [...piece.size] : undefined} castShadow receiveShadow>
    {piece.kind === 'box' && <boxGeometry args={[...piece.size]} />}
    {piece.kind === 'cylinder' && <cylinderGeometry args={[piece.size[0], piece.size[2], piece.size[1], 32]} />}
    {piece.kind === 'sphere' && <sphereGeometry args={[1, 24, 16]} />}
    {piece.kind === 'torus' && <torusGeometry args={[piece.size[0], piece.size[1], 12, 96]} />}
    <meshStandardMaterial color={piece.color} roughness={piece.roughness ?? 0.78} metalness={piece.metalness ?? 0} />
  </mesh>;
}

function ReviewRig({ fixture, ablation, view, playing, lampOn, onEnd }: {
  fixture: ReferenceScene; ablation: Ablation; view: number; playing: boolean; lampOn: boolean; onEnd: () => void;
}) {
  const { scene, gl, camera } = useThree();
  const elapsed = useRef(0);
  useEffect(() => { elapsed.current = playing ? 0 : view * 20 / 3; }, [playing, view]);
  useEffect(() => {
    if (ablation !== 'clay') return;
    const clay = clayMaterial();
    const previous = scene.overrideMaterial;
    scene.overrideMaterial = clay;
    return () => { scene.overrideMaterial = previous; clay.dispose(); };
  }, [scene, ablation]);
  useEffect(() => {
    if (ablation === 'light' || ablation === 'no-ibl') return;
    const generator = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const environment = generator.fromScene(room, 0.04);
    const previous = scene.environment;
    const intensity = scene.environmentIntensity;
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.25;
    room.dispose(); generator.dispose();
    return () => { scene.environment = previous; scene.environmentIntensity = intensity; environment.dispose(); };
  }, [scene, gl, ablation]);
  useFrame((_, delta) => {
    if (playing) {
      elapsed.current = Math.min(20, elapsed.current + delta);
      if (elapsed.current === 20) onEnd();
    }
    const at = referenceCameraAt(fixture.cameras, elapsed.current);
    camera.position.set(...(ablation === 'camera' ? at.map(v => v * 1.8) as [number, number, number] : at));
    camera.lookAt(...fixture.target);
    let lights = 0, meshes = 0, lampIntensity = 0, shadowCasters = 0;
    scene.traverse(node => { if ('isLight' in node) lights++; if (node instanceof Mesh) { meshes++; if (node.castShadow) shadowCasters++; } if (node instanceof PointLight) lampIntensity += node.intensity; });
    window.__referenceScene = { time: elapsed.current, camera: camera.position.toArray(), lights, meshes, shadowCasters,
      triangles: gl.info.render.triangles, calls: gl.info.render.calls, lampOn, lampIntensity, environment: scene.environment !== null, shadows: gl.shadowMap.enabled };
  });
  useEffect(() => () => { delete window.__referenceScene; }, []);
  return null;
}

export default function ReferenceGallery() {
  const [id, setId] = useState('interior');
  const [ablation, setAblation] = useState<Ablation>('full');
  const [view, setView] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [lampOn, setLampOn] = useState(true);
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fixture = REFERENCE_SCENES.find(entry => entry.id === id)!;
  const layout = ablation === 'layout';
  const blueprint = useMemo(() => referenceBlueprint(fixture, layout), [fixture, layout]);
  useEffect(() => {
    let active = true;
    const client = createMeshClient();
    setWorld(null); setError(null);
    void buildProxyWorldFrom(blueprint, client).then(built => {
      // Architecture below is explicitly hand-authored; no tiny placeholder terrain.
      if (active) setWorld(built.kind === 'built' ? { ...built, scenery: [] } : built);
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; client.dispose(); };
  }, [blueprint]);
  const proxy = ablation === 'proxy';
  return <main style={{ height: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#18252b', color: '#f4eee1', fontFamily: 'sans-serif' }}>
    <header style={{ padding: '14px 24px', display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
      <div><strong>Visual ceiling · hand-authored references</strong><div style={{ fontSize: 12, opacity: 0.7 }}>Development oracle · not live generation</div></div>
      <label>Scene <select aria-label="Scene" value={id} onChange={e => { setId(e.target.value); setPlaying(false); setView(0); }}>
        {REFERENCE_SCENES.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
      </select></label>
      <label>Comparison <select aria-label="Comparison" value={ablation} onChange={e => setAblation(e.target.value as Ablation)}>
        <option value="full">Full surfaces</option><option value="clay">Same geometry · original clay</option>
        <option value="proxy">Assets → bounding boxes</option><option value="layout">Assets → grid layout</option>
        <option value="light">Original light · no IBL</option><option value="camera">Camera → wide framing</option>
        <option value="no-ibl">Same light · no IBL</option><option value="no-shadows">Same light · no shadows</option>
      </select></label>
      <div>{[0, 1, 2, 3].map(index => <button key={index} aria-pressed={!playing && index === view} onClick={() => { setPlaying(false); setView(index); }}>View {index + 1}</button>)}</div>
      <button onClick={() => { if (playing) setPlaying(false); else { setView(0); setPlaying(true); } }}>{playing ? 'Stop flythrough' : 'Play 20s flythrough'}</button>
      <button aria-pressed={lampOn} onClick={() => setLampOn(value => !value)}>Lamp {lampOn ? 'on' : 'off'}</button>
    </header>
    <section style={{ position: 'relative', minHeight: 0 }}>
      <Canvas key={id} dpr={1} gl={{ ...WORLDSTREAM_GL }} shadows={ablation === 'no-shadows' ? false : WORLDSTREAM_SHADOWS} camera={{ position: [...fixture.cameras[0]], fov: 42, near: 0.1, far: 180 }}>
        <color attach="background" args={[fixture.background]} />
        <WorldstreamLighting reference={ablation === 'light' ? undefined : { kind: fixture.id, lamp: fixture.lamp, on: lampOn }} />
        <ReviewRig fixture={fixture} ablation={ablation} view={view} playing={playing} lampOn={lampOn} onEnd={() => { setView(3); setPlaying(false); }} />
        {fixture.surfaces.map(piece => <Piece key={piece.id} piece={piece.kind === 'torus' ? { ...piece, rotation: [Math.PI / 2, 0, 0] } : piece} />)}
        <mesh name="reference:lamp" position={[...fixture.lamp]}>
          <sphereGeometry args={[0.18, 20, 12]} /><meshStandardMaterial color="#e5caa3" emissive="#ffc477" emissiveIntensity={lampOn ? 3 : 0} />
        </mesh>
        {world?.kind === 'built' && <WorldstreamStage world={proxy ? { ...world, slots: world.slots.filter(entry => entry.form.kind !== 'asset') } : world} />}
        {proxy && blueprint.objects.filter(object => object.source.kind === 'asset').map(object => {
          const { min, max } = object.targetBounds;
          return <Piece key={object.stableId} piece={{ id: object.stableId, kind: 'box', at: min.map((v, i) => (v + max[i]) / 2) as unknown as Surface['at'], size: min.map((v, i) => max[i] - v) as unknown as Surface['size'], color: '#bd9c72' }} />;
        })}
      </Canvas>
      <div style={{ position: 'absolute', left: 24, bottom: 18, pointerEvents: 'none', textShadow: '0 1px 4px #000', maxWidth: 520 }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 24 }}>{fixture.title}</h1><span>{fixture.description}</span>
        <div role="status">{error ?? (!world ? 'Building reference…' : 'Reference ready')}</div>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  </main>;
}
