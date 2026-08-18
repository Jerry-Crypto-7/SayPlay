'use client';

import dynamic from 'next/dynamic';

// `ssr: false` je povinné, ne kosmetické — `<Canvas>` uvnitř vieweru potřebuje
// WebGL kontext a ten na serveru neexistuje.
const Viewer = dynamic(() => import('@/components/viewer/Viewer'), { ssr: false });

export default function EmbedView({
  layouts,
  promptId,
}: {
  readonly layouts: readonly string[];
  readonly promptId: string | null;
}) {
  return <Viewer layouts={layouts} promptId={promptId} />;
}
