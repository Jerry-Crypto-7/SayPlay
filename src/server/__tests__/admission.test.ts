/**
 * Dvě tvrzení, obě z AC úlohy T302, obě měřená proti tomu, co se doopravdy
 * stane pod zátěží:
 *
 * 1. **Deadline se počítá od přijetí požadavku, ne od začátku jeho zpracování.**
 *    Test to prokáže požadavkem, který stráví většinu rozpočtu ve frontě, a
 *    ověří, že se **odmítne**, místo aby doběhl pozdě.
 * 2. **Readiness provede skutečný zápis**, takže svazek jen pro čtení projde
 *    jako nepřipravený, i když cesta existuje.
 *
 * Hodiny jsou ruční. Skutečný čas by z prvního tvrzení udělal test na rychlost
 * stroje, a ten by pod zátěží paralelních workerů blikal — vitest jich tady
 * pouští několik a nejpomalejší soubor jede desítky vteřin.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AdmissionQueue, admit, type AdmissionPolicy } from '../admission';
import { checkReadiness, nodeReadinessFs, type ReadinessFs } from '../readiness';

const POLICY: AdmissionPolicy = { budgetMs: 10_000, minServiceMs: 2_000, maxQueued: 4 };

/** Hodiny, které se pohnou jen když jim to někdo řekne. */
function manualClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => void (current += ms) };
}

/** Uvolní smyčku událostí, aby se čekající požadavek stihl posunout dál. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe('admit', () => {
  it('požadavek přijatý právě teď má celý rozpočet', () => {
    const verdict = admit('a', 1_000, 1_000, POLICY);

    expect(verdict.admitted).toBe(true);
    expect(verdict).toMatchObject({ waitedMs: 0, deadlineMs: 11_000 });
  });

  it('deadline je absolutní čas od PŘIJETÍ, takže čekání ho neposune', () => {
    // Kdyby se počítal od začátku práce, bylo by to 9 000 + 10 000 = 19 000 —
    // tedy rozpočet, který se čekáním sám prodloužil.
    const verdict = admit('a', 1_000, 5_000, POLICY);

    expect(verdict).toMatchObject({ admitted: true, waitedMs: 4_000, deadlineMs: 11_000 });
  });

  it('když do deadlinu zbývá míň, než práce potřebuje, odmítá se', () => {
    const verdict = admit('a', 1_000, 9_500, POLICY);

    expect(verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED', waitedMs: 8_500, remainingMs: 1_500 });
  });

  it('hranice patří k přijetí: přesně `minServiceMs` ještě stačí', () => {
    expect(admit('a', 1_000, 9_000, POLICY).admitted).toBe(true);
    expect(admit('a', 1_000, 9_001, POLICY).admitted).toBe(false);
  });

  it('vypršelý rozpočet se hlásí záporným zbytkem, ne nulou', () => {
    const verdict = admit('a', 1_000, 20_000, POLICY);

    expect(verdict).toMatchObject({ admitted: false, remainingMs: -9_000 });
  });
});

describe('AdmissionQueue', () => {
  it('požadavek, který stráví většinu rozpočtu ve frontě, se odmítne místo aby doběhl pozdě', async () => {
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1 });

    // První požadavek slot obsadí a drží ho, dokud mu to nedovolíme pustit.
    let releaseFirst = (): void => undefined;
    const first = queue.submit('first', async () => {
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return 'první hotov';
    });
    await settle();

    // Druhý přichází hned za ním a od téhle chvíle čeká ve frontě.
    const started: string[] = [];
    const second = queue.submit('second', async () => {
      started.push('second');
      return 'druhý hotov';
    });
    await settle();
    expect(queue.queued).toBe(1);

    // Devět vteřin ve frontě z rozpočtu deseti. Do deadlinu zbývá 1 s, práce
    // potřebuje aspoň 2 s.
    clock.advance(9_000);
    releaseFirst();

    expect(await first).toMatchObject({ value: 'první hotov' });
    const outcome = await second;

    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED', waitedMs: 9_000 });
    expect(outcome.value).toBeNull();
    // Nejtvrdší část tvrzení: práce se **nespustila**. Verdikt padne dřív, ne
    // po ní — jinak by slot obsadila odpověď, kterou už nikdo nečte.
    expect(started).toEqual([]);
  });

  it('týž požadavek se pustí, když ve frontě strávil málo', async () => {
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1 });

    let releaseFirst = (): void => undefined;
    const first = queue.submit('first', async () => {
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return 'první hotov';
    });
    await settle();

    const second = queue.submit('second', async () => 'druhý hotov');
    await settle();

    clock.advance(3_000);
    releaseFirst();
    await first;

    expect(await second).toMatchObject({ verdict: { admitted: true, waitedMs: 3_000 }, value: 'druhý hotov' });
  });

  it('práce dostane absolutní deadline, ne rozpočet', async () => {
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1 });

    // Rozpočet by po 3 s čekání znamenal „ještě 10 s"; absolutní deadline je
    // pořád 11 000. Ten rozdíl je to, co brání téže vadě o úroveň níž.
    let releaseFirst = (): void => undefined;
    const first = queue.submit('first', async () => {
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return null;
    });
    await settle();

    const seen: number[] = [];
    const second = queue.submit('second', async (deadlineMs) => {
      seen.push(deadlineMs);
      return null;
    });
    await settle();

    clock.advance(3_000);
    releaseFirst();
    await first;
    await second;

    expect(seen).toEqual([11_000]);
  });

  it('plná fronta se odmítá při podání, ne po čekání', async () => {
    const clock = manualClock();
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 1 }, { now: clock.now, concurrency: 1 });

    let release = (): void => undefined;
    const first = queue.submit('first', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return null;
    });
    await settle();

    const second = queue.submit('second', async () => null);
    await settle();

    const third = await queue.submit('third', async () => null);

    expect(third.verdict).toMatchObject({ admitted: false, reason: 'QUEUE_FULL', waitedMs: 0 });
    expect(third.value).toBeNull();

    release();
    await first;
    await second;
  });
});

/** Souborový systém, který si pamatuje obsah a umí selhat na vyžádání. */
function fakeFs(broken: Partial<Record<'write' | 'read' | 'remove', string>> = {}): ReadinessFs & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    async write(path, bytes) {
      if (broken.write !== undefined) throw new Error(broken.write);
      files.set(path, bytes);
    },
    async read(path) {
      if (broken.read !== undefined) throw new Error(broken.read);
      const found = files.get(path);
      if (found === undefined) throw new Error(`ENOENT ${path}`);
      return found;
    },
    async remove(path) {
      if (broken.remove !== undefined) throw new Error(broken.remove);
      files.delete(path);
    },
  };
}

function deps(fs: ReadinessFs): Parameters<typeof checkReadiness>[1] {
  let tick = 0;
  let issued = 0;
  return { fs, now: () => (tick += 5), nonce: () => `n${(issued += 1)}` };
}

describe('checkReadiness', () => {
  it('zdravý adresář je připravený a nezůstane po něm soubor', async () => {
    const fs = fakeFs();
    const result = await checkReadiness('/var/tmp', deps(fs));

    expect(result.ready).toBe(true);
    expect(fs.files.size).toBe(0);
  });

  it('svazek jen pro čtení je NEPŘIPRAVENÝ, i když cesta existuje', async () => {
    // Tohle je celý rozdíl proti pingu: adresář existuje, `existsSync` by řekl
    // „připraveno", a první požadavek, který chce něco zapsat, spadne.
    const result = await checkReadiness('/var/tmp', deps(fakeFs({ write: 'EROFS: read-only file system' })));

    expect(result).toMatchObject({ ready: false, reason: 'WRITE_FAILED', detail: expect.stringContaining('EROFS') });
  });

  it('zápis, který se tvářil úspěšně a nic neuložil, je nepřipravený', async () => {
    const result = await checkReadiness('/var/tmp', deps(fakeFs({ read: 'ENOENT: no such file' })));

    expect(result).toMatchObject({ ready: false, reason: 'READ_FAILED' });
  });

  it('cizí obsah po přečtení je nepřipravený, ne připravený', async () => {
    const fs = fakeFs();
    const original = fs.read.bind(fs);
    fs.read = async (path: string) => `${await original(path)} navíc`;

    const result = await checkReadiness('/var/tmp', deps(fs));

    expect(result).toMatchObject({ ready: false, reason: 'READBACK_MISMATCH' });
  });

  it('adresář, do kterého se nedá uklidit, je nepřipravený', async () => {
    // Sonda běží každých pár vteřin po celou dobu běhu. Když po sobě neuklidí,
    // je to jediný komponent s jistotou, že disk zaplní.
    const result = await checkReadiness('/var/tmp', deps(fakeFs({ remove: 'EPERM: operation not permitted' })));

    expect(result).toMatchObject({ ready: false, reason: 'CLEANUP_FAILED' });
  });

  it('po neúspěšném čtení se uklidí taky — rozbitý svazek se nesmí plnit rychleji', async () => {
    const fs = fakeFs({ read: 'EIO' });
    await checkReadiness('/var/tmp', deps(fs));

    expect(fs.files.size).toBe(0);
  });

  it('selhání se vrací jako verdikt, nikdy jako výjimka', async () => {
    // Obslužná rutina zdravotní kontroly musí odpovědět vždycky: 503 „nejsem
    // připraven" je jiný stav než 500 „jsem rozbitý".
    await expect(checkReadiness('/var/tmp', deps(fakeFs({ write: 'ENOSPC' })))).resolves.toMatchObject({
      ready: false,
    });
  });
});

describe('checkReadiness nad skutečným souborovým systémem', () => {
  // Bez tohohle bloku je „provede skutečný zápis" splněné jen tvarem: jediná
  // implementace `ReadinessFs` by byla `Map` v testu nad ním, takže by se v
  // celé sadě nikdy nic nezapsalo. Tady se sahá na opravdový disk.
  const real = mkdtempSync(join(tmpdir(), 'readiness-real-'));
  afterAll(() => rmSync(real, { recursive: true, force: true }));

  it('zapíše, přečte a uklidí skutečný soubor', async () => {
    const result = await checkReadiness(real, { fs: nodeReadinessFs(), now: () => Date.now(), nonce: () => 'skutecny' });

    expect(result.ready).toBe(true);
    expect(readdirSync(real)).toEqual([]);
  });

  it('adresář, který neexistuje, je NEPŘIPRAVENÝ a nic po sobě nenechá', async () => {
    const missing = join(real, 'neexistuje');
    const result = await checkReadiness(missing, {
      fs: nodeReadinessFs(),
      now: () => Date.now(),
      nonce: () => 'chybejici',
    });

    expect(result).toMatchObject({ ready: false, reason: 'WRITE_FAILED' });
    expect(readdirSync(real)).toEqual([]);
  });
});

describe('checkReadiness — úklid po selhaném zápisu', () => {
  it('položka založená před selháním zápisu se smaže', async () => {
    // `ENOSPC` i vyčerpaná kvóta soubor NEJDŘÍV založí a teprve pak selžou.
    // Sonda běží každých pár vteřin, takže bez úklidu na téhle cestě by plný
    // disk plnila dál — tedy přesně to, čemu má úklid bránit.
    const files = new Map<string, string>();
    const fs: ReadinessFs = {
      async write(path, bytes) {
        files.set(path, bytes);
        throw new Error('ENOSPC: no space left on device');
      },
      async read(path) {
        const found = files.get(path);
        if (found === undefined) throw new Error('ENOENT');
        return found;
      },
      async remove(path) {
        files.delete(path);
      },
    };

    const result = await checkReadiness('/var/tmp', { fs, now: () => 0, nonce: () => 'x' });

    expect(result).toMatchObject({ ready: false, reason: 'WRITE_FAILED' });
    expect(files.size).toBe(0);
  });
});

describe('AdmissionQueue — vypršelé požadavky nedrží místo ve frontě', () => {
  it('čerstvý požadavek se nesmí odmítnout kvůli mrtvolám ve frontě', async () => {
    // Naměřeno recenzí nad předchozí verzí: dva vypršelé požadavky si držely obě
    // místa a čerstvý požadavek s CELÝM rozpočtem dostal `QUEUE_FULL`. Tedy
    // patologie, kterou tenhle soubor v hlavičce popisuje jako důvod existence.
    const clock = manualClock();
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 2 }, { now: clock.now, concurrency: 1 });

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const doomed = [queue.submit('doomed-1', async () => 'a'), queue.submit('doomed-2', async () => 'b')];
    await settle();
    expect(queue.queued).toBe(2);

    // Devět vteřin z rozpočtu deseti. Oba čekající jsou odsouzení.
    clock.advance(9_000);

    // Čerstvý požadavek se **nečeká** — má celý rozpočet, takže správná odpověď
    // není odmítnutí, ale místo ve frontě. Čekat na něj tady by byl zámek: slot
    // pořád drží `busy`.
    const fresh = queue.submit('fresh', async () => 'c');
    await settle();

    for (const outcome of await Promise.all(doomed)) {
      expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED' });
      expect(outcome.value).toBeNull();
    }

    // Mrtvoly frontu opustily a čerstvý požadavek v ní stojí místo nich.
    expect(queue.queued).toBe(1);

    release();
    await busy;

    // A doopravdy doběhne. Předchozí verze mu vrátila `QUEUE_FULL` a nikdy ho
    // nepustila, takže tahle aserce je ta, která obě chování rozliší.
    expect(await fresh).toMatchObject({ verdict: { admitted: true }, value: 'c' });
    expect(queue.running).toBe(0);
    expect(queue.queued).toBe(0);
  });

  it('uvolnění vypršelých nepustí víc práce, než dovoluje concurrency', async () => {
    // Nejjemnější past téhle opravy: kdyby probuzený vypršelý požadavek prošel
    // stejnou cestou jako propuštěný, snížil by `#running` za někoho jiného a
    // fronta by pustila dvě práce naráz při `concurrency: 1`.
    const clock = manualClock();
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 3 }, { now: clock.now, concurrency: 1 });
    const peak: number[] = [];

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      peak.push(queue.running);
      await new Promise<void>((resolve) => (release = resolve));
      return null;
    });
    await settle();

    const doomed = queue.submit('doomed', async () => null);
    await settle();
    clock.advance(9_000);

    const later = queue.submit('later', async () => {
      peak.push(queue.running);
      return null;
    });
    await settle();

    await doomed;
    release();
    await busy;
    await later;

    expect(Math.max(...peak)).toBe(1);
    expect(queue.running).toBe(0);
  });

  it('výjimka z práce propadne volajícímu, ale slot se vrátí', async () => {
    // Výjimka se schválně nepolyká: volající o vadné odpovědi poskytovatele
    // vědět má. Co se nesmí stát je, že si s sebou vezme i slot — jedna vadná
    // odpověď by pak frontu zadusila.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1 });

    await expect(
      queue.submit('vadny', async () => {
        throw new Error('poskytovatel vrátil nesmysl');
      }),
    ).rejects.toThrow('poskytovatel vrátil nesmysl');

    expect(queue.running).toBe(0);
    expect(await queue.submit('dalsi', async () => 'prošel')).toMatchObject({ value: 'prošel' });
  });
});
