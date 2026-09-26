/**
 * Neúspěšné načtení Rapieru se nesmí zapamatovat (P29A R5): server ho načítá
 * jednou při startu a zapamatovaná chyba by shodila každou fyzikální hru až do
 * restartu procesu. Modul Rapieru je tu podvržený – první `init` selže.
 */

import { describe, expect, it, vi } from 'vitest';

const rapier = vi.hoisted(() => ({ init: vi.fn<() => Promise<void>>() }));
vi.mock('@dimforge/rapier3d-compat', () => ({ default: rapier }));

import { loadRapier, rapierIfLoaded } from '../physics/world';

describe('loadRapier', () => {
  it('retries after a failed init instead of caching the failure', async () => {
    rapier.init.mockRejectedValueOnce(new Error('wasm fetch failed')).mockResolvedValue(undefined);
    await expect(loadRapier()).rejects.toThrow('wasm fetch failed');
    expect(rapierIfLoaded()).toBeNull();
    await expect(loadRapier()).resolves.toBe(rapier);
    expect(rapierIfLoaded()).toBe(rapier);
    expect(rapier.init).toHaveBeenCalledTimes(2);
    // Úspěch se naopak pamatuje: třetí volání už nic nenačítá.
    await loadRapier();
    expect(rapier.init).toHaveBeenCalledTimes(2);
  });
});
