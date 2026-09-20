import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './play.css';

export const metadata: Metadata = {
  title: 'WORLDSTREAM PLAY',
  description: 'Imagine a game. Play it.',
};

/** Obálka PLAY: vlastní paleta v `play.css`, žádný `.ws-*` panel z hlavního dema. */
export default function PlayLayout({ children }: { children: ReactNode }) {
  return <div className="play-root">{children}</div>;
}
