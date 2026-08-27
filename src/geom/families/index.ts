import { terraces } from './01-terraces';
import { spires } from './02-spires';
import { grove } from './03-grove';
import { works } from './04-works';
import type { Family } from './family';

export { familyStream, nextInt, type Family } from './family';

/** Registr rodin. Nic jiného než tenhle soubor rodiny nevydává. */
export const FAMILIES: readonly Family[] = [terraces, spires, grove, works];

export function familyById(id: string): Family | undefined {
  return FAMILIES.find((family) => family.id === id);
}

export { grove, spires, terraces, works };
