/**
 * **Zdravotní kontrola odpovídá i tehdy, když je disk rozbitý** (P15 T28).
 *
 * `Test level: full`, a je to ta třída „nikdo se nedívá": na tuhle adresu se
 * ptá vyvažovač a watchdog, ne člověk. Šťastná větev se pozná okem při prvním
 * nasazení; **selhání se nepozná nikdy**, protože nepřipravená instance vypadá
 * zvenku úplně stejně jako připravená, dokud někdo neporovná stavový kód.
 *
 * Soudí se proto tři věci, které se dají porušit tiše:
 *
 * 1. každá ze čtyř tříd selhání dá `503`, ne `200` a ne `500`;
 * 2. **ven neodejde cesta sondy ani text chyby** — mapa souborového systému
 *    instance je zadarmo pro kohokoli, kdo se zeptá;
 * 3. neověřená trvanlivost **není** porucha a instanci nevyřazuje.
 */

import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { GET, healthReport, type HealthBody } from '../route';
import type { ReadinessDeps, ReadinessFs, WriteOutcome } from '../../../../server/readiness';

const DIRECTORY = '/probe-dir';

/** Souborový systém, který se dá rozbít v jednom kroku ze tří. */
function fakeFs(
  broken: 'none' | 'write' | 'read' | 'readback' | 'cleanup',
  durabilityVerified = true,
): ReadinessFs {
  const files = new Map<string, string>();
  return {
    async write(path: string, bytes: string): Promise<WriteOutcome> {
      if (broken === 'write') throw new Error('EROFS: read-only file system');
      files.set(path, bytes);
      return { durabilityVerified };
    },
    async read(path: string): Promise<string> {
      if (broken === 'read') throw new Error('EIO: i/o error');
      // Zápis se povedl a čtení taky — jen to, co se vrátilo, je cizí. Tuhle
      // třídu ping nechytí a rozhoduje o ní jediné porovnání v sondě.
      if (broken === 'readback') return 'someone else was here';
      return files.get(path) ?? '';
    },
    async remove(path: string): Promise<void> {
      if (broken === 'cleanup') throw new Error('EPERM: operation not permitted');
      files.delete(path);
    },
  };
}

function deps(fs: ReadinessFs): ReadinessDeps {
  let clock = 0;
  return { fs, now: () => (clock += 3), nonce: () => 'test-probe' };
}

/** Co všechno by z odpovědi šlo vyčíst o instanci, kdyby se to tam dostalo. */
function leaks(body: HealthBody): string {
  return JSON.stringify(body);
}

describe('GET /api/health', () => {
  it('zdravý disk dá 200 a řekne, že se trvanlivost ověřila', async () => {
    const { status, body } = await healthReport(DIRECTORY, deps(fakeFs('none')));

    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.durabilityVerified).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.elapsedMs).toBeGreaterThan(0);
  });

  it('svazek, který `fsync` neumí, zůstává připravený', async () => {
    // Slabší kontrola, ne porucha. Kdyby tohle vyřadilo instanci, vypnul by
    // jeden druh zdravého svazku celé nasazení — a hlásilo by se to jako plný
    // disk.
    const { status, body } = await healthReport(DIRECTORY, deps(fakeFs('none', false)));

    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.durabilityVerified).toBe(false);
  });

  it.each([
    ['write', 'WRITE_FAILED'],
    ['read', 'READ_FAILED'],
    ['readback', 'READBACK_MISMATCH'],
    ['cleanup', 'CLEANUP_FAILED'],
  ] as const)('rozbité %s dá 503 a jméno třídy', async (broken, reason) => {
    const { status, body } = await healthReport(DIRECTORY, deps(fakeFs(broken)));

    // 503 znamená „běžím a nejsem připraven". 500 by znamenalo „jsem rozbitý"
    // a 200 by poslalo provoz na instanci, která neumí zapsat.
    expect(status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.reason).toBe(reason);
  });

  it('ven nejde ani cesta sondy, ani co k tomu řekl souborový systém', async () => {
    const { body } = await healthReport(DIRECTORY, deps(fakeFs('write')));

    expect(leaks(body)).not.toContain(DIRECTORY);
    expect(leaks(body)).not.toContain('test-probe');
    expect(leaks(body)).not.toContain('EROFS');
  });

  it('opravdu zapíše na disk a odpověď se nesmí ukládat do cache', async () => {
    // **Jediný test, který sahá na skutečný souborový systém** — a je tu proto,
    // že všechno ostatní běží nad atrapou. Kdyby se `nodeReadinessFs()`
    // rozešel se sondou, atrapa by o tom mlčela. Adresář je ten, do kterého
    // routa doopravdy míří.
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as HealthBody).ready).toBe(true);
    expect(tmpdir().length).toBeGreaterThan(0);
  });
});

/**
 * **Cache sondy — dvě vteřiny, které do 3. 9. 2026 neplatily** (P15 T28).
 *
 * Druhé kolo nezávislé revize našlo, že tahle logika neměla **žádný** test:
 * jediný test, který sahal na `GET()`, ho volal jednou a soudil hlavičku
 * `no-store`, což je vlastnost klientské cache — tedy pravý opak té serverové.
 * Mutant, který obě řádky cache smazal, nechal sadu zelenou.
 *
 * Soudí se proto to, co cache slibuje, a obojí se dá porušit tiše:
 *
 * 1. **souběžné dotazy sdílejí jednu sondu** — bez toho je veřejná adresa
 *    zesilovač přesně pod náporem, na který byla cache postavená;
 * 2. **razítko vzniká na konci sondy, ne na začátku** — jinak sonda delší než
 *    okno vyrobí záznam, který je prošlý ve chvíli, kdy vznikne, a cache na
 *    pomalém svazku mlčky přestane existovat.
 *
 * Sonda se předává parametrem, takže se počítá, kolikrát se doopravdy pustila.
 * Čítač je jediný pozorovatelný následek, který sonda má.
 */
describe('cache zdravotní sondy', () => {
  /** Čerstvý modul, tedy prázdná cache. Stav je modulový, ne parametr. */
  async function freshCache(): Promise<(probe: () => Promise<Answer>) => Promise<Answer>> {
    vi.resetModules();
    return (await import('../route')).cachedReport;
  }

  type Answer = Awaited<ReturnType<typeof healthReport>>;

  it('dvě stě souběžných dotazů spustí jednu sondu', async () => {
    // Revizí naměřený případ: 200 paralelních `GET /api/health` = 200 sond,
    // protože se `cached` přiřazovalo až po `await` a všechny dotazy, které
    // mezitím dorazily, viděly prázdno.
    const ready = await healthReport(DIRECTORY, deps(fakeFs('none')));
    const cachedReport = await freshCache();

    let probes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = async (): Promise<Answer> => {
      probes += 1;
      await gate;
      return ready;
    };

    const all = Promise.all(Array.from({ length: 200 }, () => cachedReport(probe)));
    release();
    const answers = await all;

    expect(probes, 'každý dotaz si spustil vlastní sondu').toBe(1);
    expect(
      answers.every((one) => one === ready),
      'někdo dostal jinou odpověď než tu jedinou naměřenou',
    ).toBe(true);
  });

  it('sonda pomalejší než okno se přesto uloží', async () => {
    // Druhá půlka nálezu. Pět dotazů za sebou nad sondou 2 100 ms dalo pět
    // sond: razítko se bralo, než sonda začala, takže záznam byl po jejím
    // doběhnutí starý 2 100 ms — tedy prošlý dřív, než ho někdo přečetl.
    const ready = await healthReport(DIRECTORY, deps(fakeFs('none')));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const cachedReport = await freshCache();

      let probes = 0;
      const slow = async (): Promise<Answer> => {
        probes += 1;
        vi.setSystemTime(Date.now() + 2_100);
        return ready;
      };

      await cachedReport(slow);
      await cachedReport(slow);

      expect(probes, 'razítko vzniklo před sondou, takže záznam byl prošlý hned').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('po dvou vteřinách se sonda pustí znovu', async () => {
    // Opačný mutant: cache, která nikdy nevyprší, hlásí zdraví instance,
    // která se mezitím rozbila — a to je horší než žádná kontrola.
    const ready = await healthReport(DIRECTORY, deps(fakeFs('none')));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const cachedReport = await freshCache();

      let probes = 0;
      const probe = async (): Promise<Answer> => {
        probes += 1;
        return ready;
      };

      await cachedReport(probe);
      vi.setSystemTime(1_999);
      await cachedReport(probe);
      expect(probes, 'cache vypršela dřív než po dvou vteřinách').toBe(1);

      vi.setSystemTime(2_000);
      await cachedReport(probe);
      expect(probes, 'cache nevypršela nikdy').toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cachuje se i verdikt „nepřipraven"', async () => {
    // Komentář u `CACHE_MS` to slibuje výslovně: plný disk se za dvě vteřiny
    // nespraví a odpověď, která by se ptala znovu, vrátí útočníkovi zesilovač
    // přesně ve chvíli, kdy je stroj nejslabší.
    const broken = await healthReport(DIRECTORY, deps(fakeFs('write')));
    const cachedReport = await freshCache();

    let probes = 0;
    const probe = async (): Promise<Answer> => {
      probes += 1;
      return broken;
    };

    const first = await cachedReport(probe);
    const second = await cachedReport(probe);

    expect(first.status).toBe(503);
    expect(second, 'nepřipravený verdikt se nezacachoval').toBe(first);
    expect(probes, 'nepřipravená instance se sondovala znovu').toBe(1);
  });
});
