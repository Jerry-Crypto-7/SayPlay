import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { preload } from 'react-dom';

import { color } from '@/brand/tokens';

import './play.css';

export const metadata: Metadata = {
  title: 'sayplay',
  description: 'Say it. Play it.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: color.cream,
};

/** Obálka PLAY: vzhled z kitu Sayplay (`docs/brand/`), tokeny v `src/brand/tokens.css`. */
export default function PlayLayout({ children }: { children: ReactNode }) {
  // Nadpisy (900) a běžný text (500) jsou na první obrazovce; tučný a obyčejný řez počkají.
  for (const cut of ['Black', 'Medium']) {
    preload(`/fonts/roboto/Roboto-${cut}.woff2`, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  }
  return <div className="play-root sp-root">{children}</div>;
}
