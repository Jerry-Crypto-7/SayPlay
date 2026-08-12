'use client';

import dynamic from 'next/dynamic';

// ssr: false je povinné, ne kosmetické — WebGL kontext na serveru neexistuje
// a `<Canvas>` by při SSR spadl na `document`.
const Stage = dynamic(() => import('@/components/Stage'), { ssr: false });

export default function Page() {
  return (
    <main style={{ height: '100dvh', width: '100vw' }}>
      <Stage />
    </main>
  );
}
