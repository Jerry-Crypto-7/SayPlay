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
import { describe, expect, it } from 'vitest';

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
