/**
 * Instalace jako aplikace (P67 T11). Service worker, který by začal ukládat do cache, by na veřejném demu tiše
 * servíroval starou hru – a vypadal by přitom úplně správně. Proto test čte zdroj workeru, ne jen jeho registraci.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SW_SCOPE, SW_URL, type SwNavigatorLike, registerSw } from '@/components/play/xr/RegisterSw';

const PUBLIC = join(process.cwd(), 'public');

interface Manifest {
  readonly id?: string;
  readonly name?: string;
  readonly start_url?: string;
  readonly scope?: string;
  readonly display?: string;
  readonly display_override?: readonly string[];
  readonly orientation?: string;
  readonly icons?: readonly { readonly src: string; readonly sizes: string; readonly purpose?: string }[];
}

const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;
const worker = readFileSync(join(PUBLIC, SW_URL), 'utf8');

describe('manifest', () => {
  it('has every field an install needs, and the start page sits inside the scope', () => {
    expect(manifest.name).toBe('sayplay');
    expect(manifest.id).toBe('/play');
    expect(manifest.start_url).toBe('/play');
    expect(manifest.scope).toBe('/play');
    expect(manifest.start_url?.startsWith(manifest.scope ?? '\0')).toBe(true);
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toEqual(['standalone']);
  });

  it('has a plain 192 and 512 icon that exist on disk', () => {
    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons?.find((entry) => entry.sizes === size && (entry.purpose ?? 'any') === 'any');
      expect(icon, size).toBeDefined();
      expect(existsSync(join(PUBLIC, icon!.src))).toBe(true);
    }
  });

  it('does not lock the orientation – a portrait phone that installs it stays portrait', () => {
    expect(manifest.orientation).toBeUndefined();
  });
});

describe('service worker', () => {
  it('stores nothing: no Cache API, no cache.put', () => {
    expect(worker).not.toMatch(/\bcaches\s*\./);
    expect(worker).not.toMatch(/cache\.put/);
    expect(worker).not.toMatch(/importScripts/);
  });

  it('has the fetch listener an install needs, and leaves every request to the browser', () => {
    expect(worker).toMatch(/addEventListener\('fetch'/);
    expect(worker).not.toMatch(/respondWith/);
  });
});

describe('registerSw', () => {
  function nav(xr: boolean | undefined): { nav: SwNavigatorLike; calls: { url: string; scope: string }[] } {
    const calls: { url: string; scope: string }[] = [];
    return {
      calls,
      nav: {
        xr: xr === undefined ? undefined : { isSessionSupported: () => Promise.resolve(xr) },
        serviceWorker: {
          register: (url, options) => {
            calls.push({ url, scope: options.scope });
            return Promise.resolve({});
          },
        },
      },
    };
  }

  it('registers the pass-through worker in a browser that can do immersive VR', async () => {
    const quest = nav(true);
    expect(await registerSw(quest.nav)).toBe(true);
    expect(quest.calls).toEqual([{ url: SW_URL, scope: SW_SCOPE }]);
  });

  it('never registers on a phone or desktop without immersive VR', async () => {
    for (const xr of [false, undefined]) {
      const phone = nav(xr);
      expect(await registerSw(phone.nav)).toBe(false);
      expect(phone.calls).toEqual([]);
    }
  });

  it('a browser without service workers, or a refused registration, is false and never throws', async () => {
    expect(await registerSw({ xr: { isSessionSupported: () => Promise.resolve(true) } })).toBe(false);
    const refused: SwNavigatorLike = {
      xr: { isSessionSupported: () => Promise.resolve(true) },
      serviceWorker: { register: () => Promise.reject(new Error('SecurityError')) },
    };
    expect(await registerSw(refused)).toBe(false);
  });
});
