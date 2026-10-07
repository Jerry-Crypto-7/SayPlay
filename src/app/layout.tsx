import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './theme.css';

// Ikony a manifest jsou z kitu Sayplay (`public/brand/app-icon/`). Barvu lišty
// pro `/play` přepisuje `src/app/play/layout.tsx`; tady zůstává tmavá plocha
// pro ostatní stránky (404).
export const metadata: Metadata = {
  title: 'sayplay',
  description: 'Say it. Play it.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/app-icon/favicon.svg', type: 'image/svg+xml' },
      { url: '/brand/app-icon/favicon.ico', sizes: 'any' },
    ],
    apple: '/brand/app-icon/app-icon-180.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Ta samá hodnota, jakou nese `--ws-background` v `theme.css` a `UI_TOKENS`
  // v kitu. Do `<meta>` se CSS proměnná dosadit nedá, tak je tu doslova a hlídá
  // to `src/app/__tests__/theme.test.ts`.
  themeColor: '#0b1114',
};

/**
 * Kořenový layout.
 *
 * Do T9 nesl styly těla inline. Teď je nese `theme.css` — jedno místo, kde je
 * paleta produktu, a jediný způsob, jak ji může použít i HUD fallbacku: ten na
 * `src/app/**` nesmí importovat (drží to důkaz izolace), ale jméno třídy je
 * obyčejný řetězec a globální styl si najde sám.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
