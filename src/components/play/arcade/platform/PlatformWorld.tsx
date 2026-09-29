'use client';

/**
 * Svět plošinovky (P32-0 T5, vlastní P32F). Zatím tenký obal nad sdíleným
 * `World` s pevným ovládáním `platform`: hladina, plošiny i boční kamera
 * (na výšku natočená, `placeAngled`) jsou dnešní.
 */

import { World, type WorldProps } from '../World';

export function PlatformWorld(props: Omit<WorldProps, 'control'>) {
  return <World {...props} control="platform" />;
}
