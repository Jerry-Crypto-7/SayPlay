'use client';

/**
 * Rekvizity sady prostředí (P26 T11) na okrajích trati: stromy, domy, regály,
 * korály… z primitiv, bez stahování. Rozmístění je čistá funkce délky trati –
 * žádná náhoda, táž hra vypadá pokaždé stejně. Na hru nesahají: stojí mimo
 * trať a jádro o nich neví.
 */

import type { Look, PropKind } from '@/play/arcade/look';

/** `sides` = obě strany dráhy (kamera za hráčem), `behind` = za tratí (boční kamera na −x). */
export type SceneryLayout = 'sides' | 'behind';

export interface SceneryPlace {
  readonly kind: PropKind;
  readonly x: number;
  readonly z: number;
  readonly scale: number;
  readonly turn: number;
}

/** Kde rekvizity stojí: krok 7 m, odsazení a velikost se střídají podle pořadí. */
export function sceneryPlaces(props: readonly PropKind[], layout: SceneryLayout, inner: number, from: number, to: number): SceneryPlace[] {
  const places: SceneryPlace[] = [];
  const sides = layout === 'sides' ? [-1, 1] : [1];
  for (let index = 0, z = from; z <= to; index += 1, z += 7) {
    for (const side of sides) {
      const n = index * 7 + (side + 1) * 3;
      places.push({
        kind: props[n % props.length] as PropKind,
        x: side * (inner + ((index * 37 + side * 11) % 5) * 1.3),
        z: z + ((index * 13) % 3),
        scale: 0.8 + ((index * 29 + side * 7) % 5) * 0.12,
        turn: (index % 4) * (Math.PI / 2),
      });
    }
  }
  return places;
}

function Prop({ kind, tint: [main, accent] }: { readonly kind: PropKind; readonly tint: Look['tint'] }) {
  switch (kind) {
    case 'tree':
      return (
        <>
          <mesh position={[0, 0.8, 0]}><cylinderGeometry args={[0.18, 0.25, 1.6, 6]} /><meshStandardMaterial color="#78350f" roughness={1} /></mesh>
          <mesh position={[0, 2.2, 0]}><sphereGeometry args={[1.1, 8, 6]} /><meshStandardMaterial color={main} roughness={0.9} flatShading /></mesh>
        </>
      );
    case 'pine':
      return (
        <>
          <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.15, 0.2, 0.8, 6]} /><meshStandardMaterial color="#78350f" roughness={1} /></mesh>
          <mesh position={[0, 2, 0]}><coneGeometry args={[1, 2.8, 7]} /><meshStandardMaterial color={main} roughness={0.9} flatShading /></mesh>
        </>
      );
    case 'palm':
      return (
        <>
          <mesh position={[0.2, 1.6, 0]} rotation={[0, 0, -0.12]}><cylinderGeometry args={[0.12, 0.2, 3.2, 6]} /><meshStandardMaterial color="#a16207" roughness={1} /></mesh>
          {[0, 1, 2, 3, 4].map((leaf) => (
            <mesh key={leaf} position={[0.4, 3.2, 0]} rotation={[0, (leaf * Math.PI * 2) / 5, 0.9]}>
              <boxGeometry args={[0.25, 1.8, 0.05]} />
              <meshStandardMaterial color={main} roughness={0.9} />
            </mesh>
          ))}
        </>
      );
    case 'cactus':
      return (
        <>
          <mesh position={[0, 1.1, 0]}><cylinderGeometry args={[0.28, 0.3, 2.2, 8]} /><meshStandardMaterial color={main} roughness={0.8} /></mesh>
          <mesh position={[0.45, 1.3, 0]}><cylinderGeometry args={[0.16, 0.16, 0.9, 8]} /><meshStandardMaterial color={main} roughness={0.8} /></mesh>
        </>
      );
    case 'rock':
      return <mesh position={[0, 0.45, 0]} scale={[1.3, 0.8, 1]}><dodecahedronGeometry args={[0.7, 0]} /><meshStandardMaterial color={accent} roughness={1} flatShading /></mesh>;
    case 'building':
      return (
        <>
          <mesh position={[0, 3.5, 0]}><boxGeometry args={[3, 7, 3]} /><meshStandardMaterial color={main} roughness={0.8} /></mesh>
          {[1.5, 3.2, 4.9].map((y) => (
            <mesh key={y} position={[0, y, -1.51]}><planeGeometry args={[2.2, 0.6]} /><meshBasicMaterial color={accent} /></mesh>
          ))}
        </>
      );
    case 'lamp':
      return (
        <>
          <mesh position={[0, 1.5, 0]}><cylinderGeometry args={[0.06, 0.08, 3, 6]} /><meshStandardMaterial color="#334155" /></mesh>
          <mesh position={[0, 3.05, 0]}><sphereGeometry args={[0.22, 8, 6]} /><meshBasicMaterial color={accent} /></mesh>
        </>
      );
    case 'shelf':
      return (
        <>
          <mesh position={[0, 1, 0]}><boxGeometry args={[0.8, 2, 3]} /><meshStandardMaterial color="#e2e8f0" roughness={0.7} /></mesh>
          {[0.5, 1.1, 1.7].map((y, row) => (
            <mesh key={y} position={[-0.42, y, 0]}><boxGeometry args={[0.05, 0.35, 2.6]} /><meshStandardMaterial color={row % 2 === 0 ? main : accent} roughness={0.6} /></mesh>
          ))}
        </>
      );
    case 'crate':
      return <mesh position={[0, 0.5, 0]}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color="#a16207" roughness={0.9} /></mesh>;
    case 'sofa':
      return (
        <>
          <mesh position={[0, 0.35, 0]}><boxGeometry args={[1, 0.7, 2.4]} /><meshStandardMaterial color={main} roughness={0.9} /></mesh>
          <mesh position={[0.4, 0.85, 0]}><boxGeometry args={[0.25, 0.7, 2.4]} /><meshStandardMaterial color={main} roughness={0.9} /></mesh>
        </>
      );
    case 'chimney':
      return (
        <>
          <mesh position={[0, 1.5, 0]}><boxGeometry args={[3, 3, 3]} /><meshStandardMaterial color={main} roughness={0.9} /></mesh>
          <mesh position={[0.8, 4.5, 0.8]}><cylinderGeometry args={[0.35, 0.45, 3, 8]} /><meshStandardMaterial color={accent} roughness={0.8} /></mesh>
        </>
      );
    case 'tower':
      return (
        <>
          <mesh position={[0, 2.5, 0]}><cylinderGeometry args={[1, 1.1, 5, 8]} /><meshStandardMaterial color={main} roughness={1} flatShading /></mesh>
          <mesh position={[0, 5.8, 0]}><coneGeometry args={[1.3, 1.6, 8]} /><meshStandardMaterial color={accent} roughness={0.8} /></mesh>
        </>
      );
    case 'grave':
      return (
        <>
          <mesh position={[0, 0.5, 0]}><boxGeometry args={[0.2, 1, 0.7]} /><meshStandardMaterial color={main} roughness={1} /></mesh>
          <mesh position={[0, 1, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.35, 0.35, 0.2, 10, 1, false, 0, Math.PI]} /><meshStandardMaterial color={main} roughness={1} /></mesh>
        </>
      );
    case 'coral':
      return (
        <>
          {[-0.3, 0, 0.35].map((dz, branch) => (
            <mesh key={dz} position={[0, 0.5 + branch * 0.2, dz]} rotation={[dz, 0, 0]}><cylinderGeometry args={[0.08, 0.14, 1 + branch * 0.4, 6]} /><meshStandardMaterial color={main} roughness={0.7} /></mesh>
          ))}
        </>
      );
    case 'seaweed':
      return <mesh position={[0, 1.2, 0]} rotation={[0, 0, 0.1]}><boxGeometry args={[0.08, 2.4, 0.35]} /><meshStandardMaterial color={accent} roughness={0.9} /></mesh>;
    case 'crystal':
      return <mesh position={[0, 0.9, 0]} rotation={[0.2, 0, 0.25]}><octahedronGeometry args={[0.8, 0]} /><meshStandardMaterial color={main} emissive={main} emissiveIntensity={0.5} roughness={0.2} flatShading /></mesh>;
    case 'iceblock':
      return <mesh position={[0, 0.6, 0]}><boxGeometry args={[1.2, 1.2, 1.2]} /><meshStandardMaterial color={accent} roughness={0.1} metalness={0.1} transparent opacity={0.85} /></mesh>;
    case 'buoy':
      return (
        <>
          <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.4, 0.5, 0.8, 10]} /><meshStandardMaterial color={main} roughness={0.6} /></mesh>
          <mesh position={[0, 1.1, 0]}><coneGeometry args={[0.3, 0.7, 8]} /><meshStandardMaterial color="#f8fafc" roughness={0.6} /></mesh>
        </>
      );
  }
}

export function Scenery({ look, layout, inner, from, to, y = 0 }: { readonly look: Look; readonly layout: SceneryLayout; readonly inner: number; readonly from: number; readonly to: number; readonly y?: number }) {
  return (
    <group>
      {sceneryPlaces(look.props, layout, inner, from, to).map((place, index) => (
        <group key={index} position={[place.x, y, place.z]} rotation={[0, place.turn, 0]} scale={place.scale}>
          <Prop kind={place.kind} tint={look.tint} />
        </group>
      ))}
    </group>
  );
}
