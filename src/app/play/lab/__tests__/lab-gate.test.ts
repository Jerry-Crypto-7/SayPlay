import { readdirSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Brána laboratorních stránek (R2, nález revize P37C T3-1): v produkci bez
 * `PLAY_LAB=1` je každá `/play/lab/*` 404. Drží ji dvě věci, které žádný e2e
 * nepouští – e2e laboratoří běží s `PLAY_LAB=1`:
 * - proměnná se čte až po `await connection()`, tedy za běhu požadavku;
 *   bez toho by ji build mohl zapéct do předrenderované stránky;
 * - `PLAY_LAB` není v `env` z `next.config.mjs`, který by ji vložil do buildu.
 */

let connected = false;
const reads: boolean[] = [];

vi.mock('next/server', () => ({
  connection: async () => {
    connected = true;
  },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const LAB = 'src/app/play/lab';
const PAGES = readdirSync(LAB, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
  .map((entry) => entry.name);

const environment = process.env;

beforeEach(() => {
  connected = false;
  reads.length = 0;
  // Každé čtení `PLAY_LAB` si poznamená, jestli už proběhlo `connection()`.
  process.env = new Proxy(
    { ...environment, NODE_ENV: 'production', PLAY_LAB: undefined },
    {
      get(target, key) {
        if (key === 'PLAY_LAB') reads.push(connected);
        return target[key as keyof typeof target];
      },
    },
  );
});

afterEach(() => {
  process.env = environment;
});

describe('/play/lab/* without PLAY_LAB', () => {
  it('covers every lab page there is', () => {
    expect(PAGES.sort()).toEqual(['ghost', 'physics', 'rules', 'terrain']);
  });

  it.each(PAGES)('%s is a 404 decided at request time, after connection()', async (name) => {
    const page = (await import(`../${name}/page.tsx`)) as { default: (props: { searchParams: Promise<object> }) => Promise<unknown> };
    await expect(page.default({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(Boolean)).toBe(true);
  });

  it('next.config.mjs never inlines PLAY_LAB into the build', () => {
    expect(readFileSync('next.config.mjs', 'utf8')).not.toMatch(/PLAY_LAB/);
  });
});
