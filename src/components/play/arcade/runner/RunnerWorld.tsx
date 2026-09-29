'use client';

/**
 * Svět běžce (P32-0 T5, vlastní P32A). Zatím tenký obal nad sdíleným `World`
 * s pevným ovládáním `runner`: dráha, kamera za hráčem i těla jsou dnešní.
 */

import { World, type WorldProps } from '../World';

export function RunnerWorld(props: Omit<WorldProps, 'control'>) {
  return <World {...props} control="runner" />;
}
