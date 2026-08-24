'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';

import { buildLayoutScene, layoutById } from '@/kit';

declare global {
  interface Window {
    __kitLayout?: {
      id: string;
      ready: boolean;
      /** `renderer.info` po skutečně vykresleném snímku, ne odhad z dat. */
      calls: number;
      triangles: number;
    };
  }
}

function FrameProbe({ id }: { id: string }) {
  const frames = useRef(0);

  useFrame(({ gl }) => {
    frames.current += 1;
    // `useFrame` běží PŘED vykreslením, takže `renderer.info` nese čísla
    // předchozího snímku. Na druhém průchodu je tedy uvnitř to, co renderer
    // opravdu nakreslil při prvním — a prázdné plátno se tím pozná.
    if (frames.current === 2) {
      window.__kitLayout = {
        id,
        ready: true,
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
      };
    }
  });

  return null;
}

export default function KitLayoutView({ layoutId }: { layoutId: string }) {
  const layout = layoutById(layoutId);
  const scene = useMemo(() => (layout ? buildLayoutScene(layout) : null), [layout]);

  if (layout === undefined || scene === null) {
    return <p data-testid="layout-missing">Layout {layoutId} is not in the kit.</p>;
  }

  return (
    <>
      <p data-testid="layout-title" style={{ position: 'absolute', margin: '0.75rem', zIndex: 1 }}>
        {layout.title} · {layout.palette}
      </p>
      <Canvas
        data-testid="layout-canvas"
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ position: [6, 6, 8], fov: 45 }}
      >
        <ambientLight intensity={0.65} />
        <directionalLight position={[5, 8, 4]} intensity={1.3} />
        <primitive object={scene} />
        <FrameProbe id={layout.id} />
      </Canvas>
    </>
  );
}
