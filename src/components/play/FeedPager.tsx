'use client';

/**
 * Feed na `/play`: od P54A T6 snap feed karet `feed/ReelFeed.tsx`. Tenhle
 * soubor zůstává jako obal pro `page.tsx`. Doporučená hra vedle pole
 * (`FeaturedGame`, P34 T3) od T12 není – její roli na desktopu přebral feed.
 */

import { ReelFeed } from './feed/ReelFeed';

export function FeedPager() {
  return <ReelFeed />;
}
