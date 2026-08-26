import { describe, expect, it, vi } from 'vitest';

import {
  FORCED_SHAPE_SCHEMA,
  askForPersistence,
  requestPersistentStorage,
  type StorageLike,
} from '@/model/local/engine';

/**
 * Žádost o trvalé úložiště (P11 T22).
 *
 * **Proč se to testuje.** Slib „podruhé se model nestahuje" stojí a padá s tím,
 * jestli prohlížeč mezipaměť vah smí vyhodit. Cesty, na kterých se to rozhoduje,
 * jsou přitom skoro všechny chybové — prohlížeč rozhraní nemá, odmítne, nebo
 * spadne — a žádná z nich se sama od sebe nespustí. Právě proto se testují: kdyby
 * se čekalo na to, až je vyvolá provoz, nevyvolá je nikdy nikdo.
 */

/** Sbírá, co by šlo do konzole. Log je tady požadavek z AC, ne ladicí výpis. */
function recorder(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message) => void lines.push(message), lines };
}

describe('askForPersistence — zeptá se, přečte odpověď a nespadne', () => {
  it('povolení vrátí true a napíše se do logu', async () => {
    const { log, lines } = recorder();
    const storage: StorageLike = { persist: () => Promise.resolve(true) };

    await expect(askForPersistence(storage, log)).resolves.toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('povolen');
  });

  it('zamítnutí vrátí false, ne null', async () => {
    // Rozdíl proti `null` nese celý význam: `false` znamená, že se prohlížeč
    // rozhodl. Slít to dohromady by v logu tvrdilo něco, co se nestalo.
    const { log, lines } = recorder();
    const storage: StorageLike = { persist: () => Promise.resolve(false) };

    await expect(askForPersistence(storage, log)).resolves.toBe(false);
    expect(lines[0]).toContain('zamítnut');
  });

  it('prohlížeč bez rozhraní dá null, a nikdo se neptal', async () => {
    const { log, lines } = recorder();

    await expect(askForPersistence(undefined, log)).resolves.toBeNull();
    expect(lines[0]).toContain('není v tomhle prohlížeči');
  });

  it('objekt bez `persist` je totéž jako žádný objekt', async () => {
    const { log, lines } = recorder();

    await expect(askForPersistence({} as StorageLike, log)).resolves.toBeNull();
    expect(lines[0]).toContain('není v tomhle prohlížeči');
  });

  it('pád při žádosti nesmí prosáknout ven', async () => {
    // Kdyby výjimka proletěla, shodila by `loadEngine` — tedy načítání modelu by
    // padlo na úklidové žádosti o místo na disku.
    const { log, lines } = recorder();
    const storage: StorageLike = { persist: () => Promise.reject(new Error('SecurityError')) };

    await expect(askForPersistence(storage, log)).resolves.toBeNull();
    expect(lines[0]).toContain('SecurityError');
  });
});

describe('requestPersistentStorage — zeptá se nejvýš jednou za život stránky', () => {
  it('dvě volání pošlou jedinou žádost', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal('navigator', { storage: { persist } });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const first = await requestPersistentStorage();
      const second = await requestPersistentStorage();

      expect(first).toBe(second);
      // Chrome umí na druhou žádost otevřít další dotaz na uživatele. Jedno volání
      // je tedy požadavek z AC, ne úspora.
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Svázaný tvar zůstává **volnou obálkou** — a je to naměřené rozhodnutí.
 *
 * 26. 8. 2026 se zkoušelo vynutit dekodérem povinné pravidlo výhry, protože
 * 15 z 24 zaznamenaných emisí žádnou akci `win` nemá. Na živém modelu to
 * shodilo překlad gramatiky (`BindingError`, 4 věty ze 4) a mírnější varianty
 * vydaly emise, které padly na produkčním schématu. Odůvodnění a čísla jsou
 * v hlavičce `FORCED_SHAPE_SCHEMA`.
 *
 * Bez tohohle testu je to jen komentář: příště někdo přidá `properties` o
 * úroveň hloub, jednotky zůstanou zelené a model se v prohlížeči přestane
 * spouštět — což se pozná až rukou, protože stránka poctivě spadne na náhradní
 * místnost a nikde není chyba.
 */
describe('svázaný tvar', () => {
  const schema = JSON.parse(FORCED_SHAPE_SCHEMA) as {
    required: string[];
    properties: Record<string, unknown>;
  };

  it('žádá pět polí obálky a nic z jejich obsahu', () => {
    expect(schema.required.sort()).toEqual(['irVersion', 'look', 'lookRevision', 'sim', 'simRevision']);
  });

  it('nechává vnitřek `sim` a `look` otevřený, protože je to odpověď na větu', () => {
    // xgrammar překládá schéma striktně: deklarované `properties` jsou celý
    // seznam povolených klíčů, ne minimum. Jakýkoli částečný tvar uvnitř by
    // modelu zakázal napsat zbytek světa.
    expect(schema.properties.sim).toEqual({ anyOf: [{ type: 'object' }, { type: 'null' }] });
    expect(schema.properties.look).toEqual({ type: 'object' });
  });
});
