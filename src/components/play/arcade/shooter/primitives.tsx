'use client';

/**
 * Tělesa střelnice a hřiště bez modelu v katalogu (P25G T6): střela, míček,
 * terč, koš, tyč, zeď, dřevěný blok. Kreslí se v kvádru těla (metry),
 * postavená na zem, střed v ose – stejně jako `FittedModel`. Nic fialového.
 */

export const SHOT_PRIMITIVES: ReadonlySet<string> = new Set(['bullet', 'ball', 'target', 'hoop', 'pole', 'wall', 'wood-block']);

/** Kroužky terče zvenku dovnitř. */
const RINGS = ['#dc2626', '#f8fafc', '#dc2626', '#f8fafc', '#facc15'] as const;

/** `block` = hmota bloku ze sady prostředí (P30B T6: pevnost ze sněhu, ne z beden). */
export function ShotPrimitive({ id, w, h, d, block }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly block?: string }) {
  if (id === 'bullet' || id === 'ball') {
    const r = Math.min(w, h, d) / 2;
    return (
      <mesh position={[0, r, 0]}>
        <sphereGeometry args={[r, 16, 12]} />
        <meshStandardMaterial color={id === 'bullet' ? '#fbbf24' : '#f97316'} roughness={0.5} emissive={id === 'bullet' ? '#f59e0b' : '#000000'} emissiveIntensity={0.6} />
      </mesh>
    );
  }
  if (id === 'target') {
    // Terč čelem k hráči (−z): soustředné kotouče na tenké noze.
    const r = Math.min(w, h) / 2;
    return (
      <>
        <mesh position={[0, h / 4, d / 2]}>
          <boxGeometry args={[0.08, h / 2, 0.08]} />
          <meshStandardMaterial color="#78350f" />
        </mesh>
        {RINGS.map((color, i) => (
          <mesh key={i} position={[0, h - r, -i * 0.01]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[r * (1 - i / RINGS.length), r * (1 - i / RINGS.length), d, 24]} />
            <meshStandardMaterial color={color} roughness={0.6} />
          </mesh>
        ))}
      </>
    );
  }
  if (id === 'hoop') {
    return (
      <mesh position={[0, h / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[w / 2, 0.05, 8, 24]} />
        <meshStandardMaterial color="#ea580c" metalness={0.4} roughness={0.4} />
      </mesh>
    );
  }
  const color = id === 'wood-block' ? (block ?? '#b45309') : id === 'wall' ? '#78716c' : '#94a3b8';
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w * 0.98, h * 0.98, d * 0.98]} />
      <meshStandardMaterial color={color} roughness={0.8} />
    </mesh>
  );
}
