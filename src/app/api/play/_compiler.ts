/**
 * Šev kompilátoru pro obálku (P23-D T1): `compileGame` z `src/play/compile`.
 * Obálka ho importuje výhradně odtud, aby šla vrstva vyměnit na jednom místě.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import { compileGame } from '@/play/compile';
import type { GameCompiler } from '@/play/contracts';

export function getCompiler(): GameCompiler {
  return compileGame;
}
