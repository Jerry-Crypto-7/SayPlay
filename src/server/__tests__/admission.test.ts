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

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { AdmissionQueue, admit, checkPolicy, MAX_DELAY_MS, type AdmissionPolicy, type CoercedReceipt } from '../admission';
import { checkReadiness, nodeReadinessDeps, nodeReadinessFs, syncIfSupported, type ReadinessFs } from '../readiness';

const POLICY: AdmissionPolicy = { budgetMs: 10_000, minServiceMs: 2_000, maxQueued: 4 };

/**
 * Hodiny, které se pohnou jen když jim to někdo řekne — **a plánovač, který se
 * hýbe s nimi.**
 *
 * Fronta si probuzení vypršelých plánuje sama. Kdyby ho plánovala skutečným
 * `setTimeout`, čekala by na skutečné vteřiny, zatímco její vlastní čas by
 * stál — takže by v testu nikdy nepřišlo. `advance()` proto vedle posunu času
 * spustí i všechna probuzení, která tím dozrála.
 */
function manualClock(start = 1_000): {
  now: () => number;
  advance: (ms: number) => void;
  schedule: (fn: () => void, delayMs: number) => () => void;
} {
  let current = start;
  let issued = 0;
  const pending = new Map<number, { readonly at: number; readonly fn: () => void }>();

  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      // Snímek schválně: probuzení, které si naplánuje další, nesmí doběhnout
      // ve stejném posunu — jinak by se `advance` zacyklil.
      for (const [id, timer] of [...pending]) {
        if (timer.at <= current && pending.delete(id)) timer.fn();
      }
    },
    schedule: (fn, delayMs) => {
      const id = (issued += 1);
      pending.set(id, { at: current + delayMs, fn });
      return () => void pending.delete(id);
    },
  };
}

/** Uvolní smyčku událostí, aby se čekající požadavek stihl posunout dál. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/**
 * Fronta si o hlášení srovnaných časů říká povinně, takže ho musí dodat každý
 * test. Ty, které srovnání neměří, dodávají tohle.
 */
const ignoreCoercions = (): void => undefined;

/** Zápisník ohlášených srovnání pro testy, které je měří. */
function coercionLog(): { readonly seen: CoercedReceipt[]; readonly onCoercedReceipt: (c: CoercedReceipt) => void } {
  const seen: CoercedReceipt[] = [];
  return { seen, onCoercedReceipt: (c) => void seen.push(c) };
}

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
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

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
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

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
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

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
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 1 }, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

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
function fakeFs(
  broken: Partial<Record<'write' | 'read' | 'remove', string>> = {},
  durabilityVerified = true,
): ReadinessFs & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    async write(path, bytes) {
      if (broken.write !== undefined) throw new Error(broken.write);
      files.set(path, bytes);
      return { durabilityVerified };
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

function deps(
  fs: ReadinessFs,
  capMisconfigured: () => boolean = () => false,
): Parameters<typeof checkReadiness>[1] {
  let tick = 0;
  let issued = 0;
  return { fs, now: () => (tick += 5), nonce: () => `n${(issued += 1)}`, capMisconfigured };
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

/**
 * **Strop bez knihy je porucha nasazení, ne poskytovatele** (`T29-readinessledger`,
 * nezávislá revize 4. 9. 2026). Nakonfigurovaný model nad chybějící knihou
 * odmítne **každé** placené volání (`STORE_UNCONFIGURED`) a porotce přitom čte
 * „the model could not be reached" — vina padne na poskytovatele, ke kterému se
 * nikdy nevolalo. Překlep v `VERCEL_ENV` (`prod` místo `production`) tak dneska
 * projde kontrolou připravenosti a začne brát provoz.
 */
describe('checkReadiness — strop bez knihy', () => {
  it('nakonfigurovaný model bez knihy je NEPŘIPRAVENÝ, a nesáhne přitom na disk', async () => {
    // ⚠ **Počítají se zápisy, ne přeživší soubory — změřeno.** Nad `fakeFs.files`
    // mutant, který bránu přesune až za sondu, **přežil**: úspěšný cyklus po sobě
    // uklidí, takže mapa je prázdná v obou případech. Počítadlo je ten rozdíl.
    const base = fakeFs({});
    let zápisů = 0;
    const fs = {
      ...base,
      write: async (path: string, bytes: string) => {
        zápisů += 1;
        return base.write(path, bytes);
      },
    };
    const result = await checkReadiness('/var/tmp', deps(fs, () => true));

    expect(result).toMatchObject({ ready: false, reason: 'LEDGER_UNCONFIGURED' });
    // **Levná větev je i důkaz pořadí.** Kdyby stála až za sondou, platila by
    // nepřipravená instance zápis a `fsync` při každém dotazu vyvažovače.
    expect(zápisů, 'sonda zapisovala, ačkoli měla odmítnout dřív').toBe(0);
  });

  /**
   * ⚠ **Polarita, a je to celá obhajoba té větve.** Nasazení **bez modelu**
   * knihu nepotřebuje a musí zůstat v rotaci — dnešní demo běží bez `.env`,
   * takže bez téhle půlky podmínky by se z rotace vyřadilo celé, včetně
   * offline větve, korpusu a meshingu, které přes strop vůbec nechodí.
   */
  it('nasazení bez modelu zůstává PŘIPRAVENÉ, i když žádnou knihu nemá', async () => {
    const result = await checkReadiness('/var/tmp', deps(fakeFs({}), () => false));

    expect(result).toMatchObject({ ready: true });
  });

  /**
   * **Tenhle test měří zapojení, ne větev.** Dva testy nad ním si `capMisconfigured`
   * podstrčí, takže by zůstaly zelené i nad továrnou, která se ptá jen na knihu —
   * a právě ta by dnešní demo bez `.env` vyřadila z rotace.
   */
  it('továrna se ptá na obojí: bez modelu mlčí, s modelem a bez knihy křičí', () => {
    const původní = { ...process.env };
    try {
      for (const klíč of ['WORLDSMITH_MODEL_ENDPOINT', 'WORLDSMITH_MODEL_KEY',
        'WORLDSMITH_USD_PER_MTOK_OUT', 'WORLDSMITH_SPEND_STORE_URL',
        'WORLDSMITH_SPEND_STORE_TOKEN', 'VERCEL', 'VERCEL_ENV'])
        delete process.env[klíč];

      expect(
        nodeReadinessDeps().capMisconfigured(),
        'demo bez `.env` se vyřadilo z rotace kvůli stropu, který nepotřebuje',
      ).toBe(false);

      process.env.WORLDSMITH_MODEL_ENDPOINT = 'https://příklad.test/v1/messages';
      process.env.WORLDSMITH_MODEL_KEY = 'klíč';
      process.env.WORLDSMITH_USD_PER_MTOK_OUT = '15';

      expect(
        nodeReadinessDeps().capMisconfigured(),
        'model bez knihy prošel připravený — každé placené volání pak odmítne',
      ).toBe(true);
    } finally {
      for (const klíč of Object.keys(process.env)) if (!(klíč in původní)) delete process.env[klíč];
      Object.assign(process.env, původní);
    }
  });
});

describe('checkReadiness nad skutečným souborovým systémem', () => {
  // Bez tohohle bloku je „provede skutečný zápis" splněné jen tvarem: jediná
  // implementace `ReadinessFs` by byla `Map` v testu nad ním, takže by se v
  // celé sadě nikdy nic nezapsalo. Tady se sahá na opravdový disk.
  const real = mkdtempSync(join(tmpdir(), 'readiness-real-'));
  afterAll(() => rmSync(real, { recursive: true, force: true }));

  it('zapíše, přečte a uklidí skutečný soubor', async () => {
    const result = await checkReadiness(real, { fs: nodeReadinessFs(), now: () => Date.now(), nonce: () => 'skutecny', capMisconfigured: () => false });

    expect(result.ready).toBe(true);
    expect(readdirSync(real)).toEqual([]);
    // Dočasný adresář `fsync` umí, takže tady musí projít PLNÁ kontrola. Kdyby
    // ne, je to nález o téhle mašině, ne planý poplach: soubor výš tvrdí, že
    // zápis se vynutí na zařízení, a tady by to přestalo platit.
    expect(result).toMatchObject({ durabilityVerified: true });
  });

  it('adresář, který neexistuje, je NEPŘIPRAVENÝ a nic po sobě nenechá', async () => {
    const missing = join(real, 'neexistuje');
    const result = await checkReadiness(missing, {
      fs: nodeReadinessFs(),
      now: () => Date.now(),
      nonce: () => 'chybejici',
      capMisconfigured: () => false,
    });

    expect(result).toMatchObject({ ready: false, reason: 'WRITE_FAILED' });
    expect(readdirSync(real)).toEqual([]);
  });

  it('dvě souběžné sondy nad týmž adresářem jsou OBĚ připravené', async () => {
    // Sonda běží každých pár vteřin pod vyvažovačem, takže dvě naráz nad týmž
    // adresářem není okrajový případ, ale běžný provoz. Se sdíleným nonce míří
    // obě na tentýž soubor: jedna ho smaže první a druhá skončí na
    // `CLEANUP_FAILED (ENOENT unlink)` — tedy 503 na zdravém železe.
    const [first, second] = await Promise.all([
      checkReadiness(real, nodeReadinessDeps()),
      checkReadiness(real, nodeReadinessDeps()),
    ]);

    expect(first).toMatchObject({ ready: true });
    expect(second).toMatchObject({ ready: true });
    // Obě uspěly proto, že si nesáhly na tentýž soubor — ne náhodou.
    expect(first.probePath).not.toBe(second.probePath);
    expect(readdirSync(real)).toEqual([]);
  });

  it('továrna vydá pokaždé jiný nonce, i mezi dvěma nezávislými závislostmi', () => {
    // Vlastnost, na které ten test nad tímhle stojí, měřená přímo. Souběh na
    // disku je pravděpodobnostní — dvě sondy se za příznivého prokládání minou
    // i se sdíleným nonce — takže tvrzení „nesrazí se" nesmí viset jen na něm.
    const deps = nodeReadinessDeps();
    const issued = new Set(Array.from({ length: 100 }, () => deps.nonce()));

    expect(issued.size).toBe(100);
    expect(nodeReadinessDeps().nonce()).not.toBe(nodeReadinessDeps().nonce());
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

    const result = await checkReadiness('/var/tmp', { fs, now: () => 0, nonce: () => 'x', capMisconfigured: () => false });

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
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 2 }, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

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
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 3 }, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });
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
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    await expect(
      queue.submit('vadny', async () => {
        throw new Error('poskytovatel vrátil nesmysl');
      }),
    ).rejects.toThrow('poskytovatel vrátil nesmysl');

    expect(queue.running).toBe(0);
    expect(await queue.submit('dalsi', async () => 'prošel')).toMatchObject({ value: 'prošel' });
  });
});

describe('AdmissionQueue — čas přijetí a probuzení bez dalšího provozu', () => {
  it('čas přijetí patří volajícímu: požadavek, který čekal PŘED podáním, se odmítne', async () => {
    // Nález recenze nad předchozí verzí: `receivedAtMs` se bralo z okamžiku,
    // kdy se zavolá `submit()`. Všechno před tím — načtení těla, moderace a
    // hlavně fronta ve smyčce událostí, kterou zátěž ve skutečnosti je — bylo
    // zadarmo, takže deadline zůstal „od začátku našeho zpracování", jen o
    // patro výš.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    // Fronta je prázdná a slot volný. O verdiktu tedy nerozhoduje čekání v ní —
    // rozhoduje jediná věc: že požadavek dorazil o devět vteřin dřív, než se
    // sem dostal.
    //
    // Čas přijetí je z okamžiku, kdy fronta vznikla, a hodiny se posunou až
    // potom. Požadavek přijatý dřív, než fronta existovala, je nesmysl a fronta
    // ho schválně nebere — viz sada „čas přijetí před vznikem fronty".
    const receivedAtMs = clock.now();
    clock.advance(9_000);

    const started: string[] = [];
    const late = await queue.submit(
      'late',
      async () => {
        started.push('late');
        return 'x';
      },
      receivedAtMs,
    );

    expect(late.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED', waitedMs: 9_000 });
    expect(late.value).toBeNull();
    expect(started).toEqual([]);

    // Rozlišovací polovina, a je to ta, kvůli které aserce nahoře něco tvrdí.
    // TENTÝŽ požadavek bez času přijetí projde; bez tohohle by nahoře prošla i
    // implementace, která parametr ignoruje a odmítá všechno.
    const fresh = await queue.submit('fresh', async () => {
      started.push('fresh');
      return 'x';
    });

    expect(fresh.verdict).toMatchObject({ admitted: true, waitedMs: 0 });
    expect(started).toEqual(['fresh']);
  });

  it('plná fronta hlásí skutečné čekání, ne nulu', async () => {
    // `QUEUE_FULL` se vracelo s `waitedMs: 0` a celým rozpočtem jako zbytkem.
    // To je pravda jen pro požadavek podaný v tomtéž okamžiku, kdy dorazil —
    // tedy pro ten předpoklad, který čas přijetí ruší.
    const clock = manualClock();
    const queue = new AdmissionQueue({ ...POLICY, maxQueued: 1 }, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const waiting = queue.submit('waiting', async () => 've frontě');
    await settle();
    expect(queue.queued).toBe(1);

    const receivedAtMs = clock.now();
    clock.advance(4_000);
    const rejected = await queue.submit('rejected', async () => 'nikdy', receivedAtMs);
    expect(rejected.verdict).toMatchObject({
      admitted: false,
      reason: 'QUEUE_FULL',
      waitedMs: 4_000,
      remainingMs: 6_000,
    });

    release();
    await busy;
    await waiting;
  });

  it('čekající dostane verdikt sám od sebe, bez dalšího provozu', async () => {
    // Nález recenze: `#wakeExpired()` se volalo jen ze `submit()`, takže žádný
    // časovač neexistoval. Po nárazu provozu a následném tichu se čekající
    // dozvěděl `DEADLINE_EXCEEDED` teprve, až někdo přišel — u naměřeného
    // rozpočtu 60 s tedy celou minutu poté, co jeho odpověď přestala mít smysl.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const doomed = queue.submit('doomed', async () => 'nikdy');
    await settle();
    expect(queue.queued).toBe(1);

    // Devět vteřin ticha. Žádné podání, žádné uvolnění slotu — jediné, co se
    // stalo, je že čas došel.
    clock.advance(9_000);

    // Bez časovače se tenhle `await` nedočká vůbec a test spadne na vypršení.
    const outcome = await doomed;
    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED' });
    expect(outcome.value).toBeNull();

    // Nejtvrdší část tvrzení: `busy` slot pořád drží. Nikdo ho neuvolnil, takže
    // probuzení nemohlo přijít odjinud než z časovače. Bez téhle aserce by test
    // prošel i nad frontou, která čekající probouzí uvolněním slotu.
    expect(queue.running).toBe(1);
    expect(queue.queued).toBe(0);

    release();
    expect(await busy).toMatchObject({ value: 'hotovo' });
  });
});

describe('AdmissionQueue — časovač, který dosedne přesně na hranici', () => {
  it('probuzení na hranici nikoho neuvolní, ale musí si naplánovat další', async () => {
    // Na hranici rozpočtu zbývá přesně `minServiceMs`, takže se nic neuvolní.
    // To je v pořádku — vadné by bylo, kdyby se tím plánování zastavilo: čekající
    // by pak seděl ve frontě navždy, protože další podání už nepřijde. Tenhle
    // test drží ten druhý pokus, ne první.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const doomed = queue.submit('doomed', async () => 'nikdy');
    await settle();

    // Přijetí v 1 000, rozpočet 10 000, nejkratší práce 2 000 → hranice je
    // přesně v 9 000. Sem se doskočí na jeden zátah, takže časovač dosedne na ni.
    clock.advance(8_000);
    await settle();
    expect(queue.queued, 'na hranici ještě `minServiceMs` zbývá — uvolnit se nesmí nikdo').toBe(1);

    // Jediná milisekunda navíc, žádné podání, žádné uvolnění slotu.
    clock.advance(1);

    const outcome = await doomed;
    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED' });
    expect(queue.running).toBe(1);

    release();
    await busy;
  });
});

describe('AdmissionQueue — plánovač, který se doopravdy nasazuje', () => {
  it('čekající se probudí i bez vloženého plánovače', async () => {
    // Nález nezávislé revize: všechny fronty nad tímhle blokem si plánovač
    // vkládají, takže výchozí `setTimeout` větev nikdy neběžela. Revize jí
    // nahradila tělo za „nenaplánuj nic" a celý soubor zůstal zelený — sada
    // tedy potvrzovala vlastnost, kterou neměřila. Tohle je jediné místo, kde
    // jede kód, který se nasazuje: skutečné hodiny, skutečný časovač.
    const queue = new AdmissionQueue(
      { budgetMs: 150, minServiceMs: 60, maxQueued: 4 },
      { now: () => Date.now(), concurrency: 1, onCoercedReceipt: ignoreCoercions },
    );

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const doomed = queue.submit('doomed', async () => 'nikdy');
    await settle();
    expect(queue.queued).toBe(1);

    // Nic se nepodává a slot se neuvolňuje. Verdikt může přijít jedině z
    // časovače, který si fronta naplánovala sama.
    const outcome = await doomed;
    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED' });
    expect(queue.running).toBe(1);

    release();
    expect(await busy).toMatchObject({ value: 'hotovo' });
  }, 10_000);
});

describe('AdmissionQueue — čas přijetí přichází zvenčí, takže může být nesmysl', () => {
  // Nález nezávislé revize, reprodukovaný proti výchozímu plánovači: `NaN`
  // projde porovnáním „vypršel?" jako nepravda a nekonečno i čas v budoucnosti
  // vyrobí odklad delší, než `setTimeout` umí. Node ho přetočí na 1 ms a
  // probuzení se změní ve vytížené čekání na celé dny — čekající přitom verdikt
  // nedostane vůbec nikdy. Nic takového dneska nikdo neposílá, protože frontu
  // zatím nikdo nevolá; vzniklo to ale tou úpravou, která ten parametr zavedla.
  const NONSENSE: ReadonlyArray<readonly [string, (nowMs: number) => number]> = [
    ['NaN', () => Number.NaN],
    ['nekonečno', () => Number.POSITIVE_INFINITY],
    ['čas v budoucnosti (záměna vteřin za milisekundy)', (nowMs) => nowMs + 3_000_000_000],
  ];

  it.each(NONSENSE)('%s se bere jako „dorazilo teď" a čekající verdikt dostane', async (_label, value) => {
    const clock = manualClock();
    const delays: number[] = [];
    const queue = new AdmissionQueue(POLICY, {
      now: clock.now,
      concurrency: 1,
      onCoercedReceipt: ignoreCoercions,
      schedule: (fn, delayMs) => {
        delays.push(delayMs);
        return clock.schedule(fn, delayMs);
      },
    });

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const doomed = queue.submit('doomed', async () => 'nikdy', value(clock.now()));
    await settle();
    expect(queue.queued).toBe(1);

    // Každý naplánovaný odklad musí být konečný a v mezích, které `setTimeout`
    // umí. Bez oříznutí je tady `NaN` nebo víc než měsíc.
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeLessThanOrEqual(2_147_483_647);
    }

    // A hlavně: verdikt přijde. Bez opravy se tenhle `await` nedočká.
    clock.advance(9_000);
    expect((await doomed).verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED' });

    release();
    await busy;
  });

  it('minulý čas přijetí zůstává minulý — oříznutí platí jen na nesmysly', async () => {
    // Rozlišovací polovina. Bez ní by aserce nahoře prošly i nad implementací,
    // která parametr zahodí vždycky — a to je právě ta vada, kterou zavedení
    // toho parametru mělo odstranit.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    const receivedAtMs = clock.now();
    clock.advance(9_000);
    const outcome = await queue.submit('late', async () => 'nikdy', receivedAtMs);

    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED', waitedMs: 9_000 });
    expect(queue.coercedReceipts, 'poctivý čas se srovnávat nesmí').toBe(0);
  });
});

describe('vynucení zápisu na zařízení — „nepodporuji" není „nepovedlo se"', () => {
  // Nález nezávislé revize. `sync()` přidalo cestu, kterou sonda předtím neměla:
  // sdílené svazky pod kontejnerem a některé síťové disky `fsync` neimplementují
  // a odmítnou ho `EINVAL`. Bez rozlišení by z toho byl `WRITE_FAILED` na
  // dokonale zapisovatelném svazku — tedy trvalá 503 a vyřazení instance z
  // vyvažovače kvůli DRUHU disku, ne kvůli jeho stavu.
  const throwing = (code: string): { sync: () => Promise<void> } => ({
    sync: async () => {
      const error = new Error(`fsync: ${code}`) as Error & { code: string };
      error.code = code;
      throw error;
    },
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    '%s znamená „tenhle svazek to neumí" a hlásí se jako NEOVĚŘENO',
    async (code) => {
      // `false`, ne `undefined`: spolknout odmítnutí a mlčet by znamenalo, že
      // přeskočený krok vypadá zvenčí stejně jako provedený.
      await expect(syncIfSupported(throwing(code))).resolves.toBe(false);
    },
  );

  it.each(['EIO', 'ENOSPC', 'EDQUOT'])('%s je naopak skutečné selhání a propadne dál', async (code) => {
    // Tohle je přesně ta třída „zápis se tvářil úspěšně a nic neuložil", kvůli
    // které `sync()` v sondě vůbec je. Spolknout ji by zrušilo celý ten krok.
    await expect(syncIfSupported(throwing(code))).rejects.toThrow(code);
  });

  it('chyba bez kódu se propouští dál — neznámé se nepovažuje za neškodné', async () => {
    await expect(syncIfSupported({ sync: async () => Promise.reject(new Error('bez kódu')) })).rejects.toThrow(
      'bez kódu',
    );
  });

  it('svazek, který sync umí, hlásí OVĚŘENO', async () => {
    await expect(syncIfSupported({ sync: async () => undefined })).resolves.toBe(true);
  });
});

describe('AdmissionQueue — čas přijetí před vznikem fronty', () => {
  it('chybějící hlavička se nesmí tvářit jako požadavek z roku 1970', async () => {
    // Nález druhé nezávislé revize, a je to ta nebezpečnější polovina kontroly.
    // `Number(null)` i `Number('')` dávají `0` — konečné číslo v minulosti,
    // takže původní kontrola „konečné a ne v budoucnosti" ho pustila dál.
    // Rozpočet takového požadavku je vyčerpaný o padesát let, takže by se
    // odmítl **každý** požadavek, propustnost by byla nulová a nikde by o tom
    // nebyl řádek. Chybějící hlavička je přitom vada u volajícího, ne důvod
    // vypnout provoz.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });

    clock.advance(5_000);
    const outcome = await queue.submit('bez-hlavicky', async () => 'prošel', Number(null));

    expect(outcome.verdict).toMatchObject({ admitted: true, waitedMs: 0 });
    expect(outcome.value).toBe('prošel');
  });

  it('srovnání se počítá — tiché zotavení není totéž co zdraví', async () => {
    // Fronta se z nesmyslu zotaví, ale tím se z ní stane naivní verze „od
    // začátku našeho zpracování", které se celý ten soubor snaží zabránit —
    // a `waitedMs: 0` u každého požadavku vypadá naprosto zdravě. Bez čítače
    // není ta degradace odkud poznat.
    const clock = manualClock();
    const queue = new AdmissionQueue(POLICY, { now: clock.now, concurrency: 1, schedule: clock.schedule, onCoercedReceipt: ignoreCoercions });
    clock.advance(5_000);

    expect(queue.coercedReceipts).toBe(0);

    await queue.submit('a', async () => 'x', Number.NaN);
    await queue.submit('b', async () => 'x', 0);
    await queue.submit('c', async () => 'x', clock.now() + 3_000_000_000);

    expect(queue.coercedReceipts).toBe(3);

    // Poctivý čas přijetí čítač nezvedne — jinak by ukazoval na provoz, ne na vadu.
    await queue.submit('d', async () => 'x', clock.now() - 1_000);
    expect(queue.coercedReceipts).toBe(3);
  });
});

describe('admit — je exportovaná, takže má tutéž kontrolu jako fronta', () => {
  it('nesmyslný čas přijetí nevyrobí deadline, který nikdy nevyprší', () => {
    // Nález druhé nezávislé revize: kontrola byla jen ve `submit()`, přitom
    // `admit()` je exportovaná a dokumentovaná jako čistá rozhodovací funkce.
    // Bez kontroly vrací `admitted: true` s `deadlineMs: NaN` — a ten by se
    // předal do práce jako deadline, který nikdy nenastane.
    const verdict = admit('x', Number.NaN, 10_000, POLICY);

    expect(verdict).toMatchObject({ admitted: true, waitedMs: 0 });
    expect(verdict.admitted && Number.isFinite(verdict.deadlineMs)).toBe(true);
    expect(verdict.admitted && verdict.deadlineMs).toBe(20_000);
  });

  it('poctivý čas přijetí zůstává nedotčený', () => {
    const verdict = admit('x', 1_000, 10_000, POLICY);

    expect(verdict).toMatchObject({ admitted: false, reason: 'DEADLINE_EXCEEDED', waitedMs: 9_000 });
  });
});

describe('vynucení zápisu — odmítnutí, které není objekt', () => {
  it('`Promise.reject(null)` se propustí dál, ne jako TypeError přes původní chybu', async () => {
    // Export téhle funkce ji otevřel i handlerům, které nejsou `fs`. Čtení
    // `.code` na `null` by shodilo `TypeError` a ten by původní příčinu zakryl.
    await expect(syncIfSupported({ sync: async () => Promise.reject(null) })).rejects.toBeNull();
  });

  it('odmítnutí řetězcem se taky propustí dál', async () => {
    await expect(syncIfSupported({ sync: async () => Promise.reject('EINVAL') })).rejects.toBe('EINVAL');
  });
});

describe('AdmissionQueue — proces nesmí skončit dřív, než čekající dostane verdikt', () => {
  // Nález druhé nezávislé revize, a je to jediná vlastnost v tomhle souboru,
  // kterou uvnitř vitestu změřit NEJDE: vitest sám drží smyčku událostí naživu,
  // takže by test prošel i nad `unref()`. Oracle je proto skutečný proces.
  //
  // Scéna je postavená tak, aby časovač vypršení byl jediný živý handle:
  // slot obsadí práce, která se sama nedokončí (nesplněný `Promise` žádný handle
  // nedrží), a druhý požadavek proto může verdikt dostat jedině z něj.
  //
  // S `unref()` Node skončí kódem 0 a nevypíše nic — `submit()` se nedočká
  // verdiktu ani chyby. Bez něj časovač doběhne, verdikt se vypíše, a fronta
  // se po vyprázdnění nepřeplánuje, takže proces skončí hned po něm.
  it('čekající verdikt dostane i tehdy, když je časovač vypršení jediný živý handle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldsmith-loop-'));
    const child = join(dir, 'child.mjs');
    const source = new URL('../admission.ts', import.meta.url).href;

    writeFileSync(
      child,
      [
        `import { AdmissionQueue } from ${JSON.stringify(source)};`,
        'const queue = new AdmissionQueue(',
        '  { budgetMs: 300, minServiceMs: 120, maxQueued: 4 },',
        '  { now: () => Date.now(), concurrency: 1, onCoercedReceipt: () => undefined },',
        ');',
        "void queue.submit('busy', () => new Promise(() => undefined));",
        "queue.submit('doomed', async () => 'nikdy').then((outcome) => {",
        '  process.stdout.write(JSON.stringify(outcome.verdict));',
        '});',
      ].join('\n'),
      'utf-8',
    );

    try {
      const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', child], {
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(run.stdout.trim(), 'proces skončil dřív, než verdikt dorazil').not.toBe('');
      expect(JSON.parse(run.stdout.trim())).toMatchObject({
        admitted: false,
        id: 'doomed',
        reason: 'DEADLINE_EXCEEDED',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('checkReadiness — přeskočená trvanlivost se pozná z verdiktu', () => {
  // Nález druhé nezávislé revize: `syncIfSupported()` odmítnutí `EINVAL`
  // správně spolkne, jenže sonda pak trvale hlásí záruku, kterou přestala
  // kontrolovat — a z verdiktu to nešlo poznat, protože obě větve vracely
  // tutéž větu o zdraví.
  it('svazek, který fsync neumí, je PŘIPRAVENÝ, ale trvanlivost hlásí jako neověřenou', async () => {
    const result = await checkReadiness('/var/tmp', deps(fakeFs({}, false)));

    // `ready: true` je schválně: druh svazku není nemoc a instanci vyřadit nesmí.
    expect(result).toMatchObject({ ready: true, durabilityVerified: false });
  });

  it('plná kontrola se od ní odliší', async () => {
    // Rozlišovací polovina. Bez ní by aserce nahoře prošla i nad implementací,
    // která hlásí `false` vždycky — tedy nad sondou, co si nevěří nikdy.
    const result = await checkReadiness('/var/tmp', deps(fakeFs({}, true)));

    expect(result).toMatchObject({ ready: true, durabilityVerified: true });
  });
});

describe('AdmissionQueue — srovnání času přijetí se hlásí, ne jen počítá', () => {
  // Čítač je souhrn: někdo ho musí přečíst, a zapojení, které na to zapomene,
  // je zpátky v tichém režimu. Hlášení je proto povinná závislost — frontu bez
  // něj nejde postavit — a jde ven ve chvíli, kdy k srovnání došlo.
  it('každé srovnání se ohlásí hned, s hodnotou, kterou volající poslal', async () => {
    const clock = manualClock();
    const log = coercionLog();
    const queue = new AdmissionQueue(POLICY, {
      now: clock.now,
      concurrency: 1,
      schedule: clock.schedule,
      onCoercedReceipt: log.onCoercedReceipt,
    });
    clock.advance(5_000);

    await queue.submit('a', async () => 'x', Number.NaN);
    await queue.submit('b', async () => 'x', 0);

    expect(log.seen).toEqual([
      { id: 'a', claimedMs: Number.NaN, usedMs: 6_000 },
      { id: 'b', claimedMs: 0, usedMs: 6_000 },
    ]);
    // Hlášení a čítač musí říkat totéž — jinak by se dalo věřit tomu horšímu z nich.
    expect(queue.coercedReceipts).toBe(log.seen.length);
  });

  it('poctivý čas přijetí se neohlásí — jinak by hlášení ukazovalo na provoz, ne na vadu', async () => {
    const clock = manualClock();
    const log = coercionLog();
    const queue = new AdmissionQueue(POLICY, {
      now: clock.now,
      concurrency: 1,
      schedule: clock.schedule,
      onCoercedReceipt: log.onCoercedReceipt,
    });
    clock.advance(5_000);

    await queue.submit('poctivy', async () => 'x', clock.now() - 1_000);

    expect(log.seen).toEqual([]);
    expect(queue.coercedReceipts).toBe(0);
  });
});

describe('nodeReadinessFs — krok trvanlivosti se měří na adaptéru, který se NASAZUJE', () => {
  // Nález čerstvého recenzenta nad `eee9e1f`, a je to díra v důkazu, ne v kódu:
  // `durabilityVerified` se dosud ověřovalo jen přes `Map` v testu a přes
  // `syncIfSupported()` krmenou podvrženým handlem. Nad skutečným adaptérem
  // stála jediná aserce — „na tmpdir vyjde `true`" — a tu splní i implementace,
  // která `syncIfSupported()` nezavolá vůbec a `true` si napíše natvrdo.
  //
  // `write()` si `node:fs/promises` importuje až za běhu, takže se dá podstrčit
  // a s ním i handle, jehož `sync()` odmítne `EINVAL`. To je disk, který zápis
  // přijme a trvanlivost nepotvrdí — přesně ten, který se v tmpdiru vyrobit nedá.
  const handleCalls: string[] = [];

  function mockFsPromises(syncFails: boolean): void {
    handleCalls.length = 0;
    vi.doMock('node:fs/promises', () => ({
      open: async () => ({
        async write() {
          handleCalls.push('write');
        },
        async sync() {
          handleCalls.push('sync');
          if (syncFails) throw Object.assign(new Error('fsync: EINVAL'), { code: 'EINVAL' });
        },
        async close() {
          handleCalls.push('close');
        },
      }),
    }));
  }

  afterAll(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('svazek, který fsync odmítne, se zapíše — a nasazovaný adaptér to přizná', async () => {
    mockFsPromises(true);
    vi.resetModules();
    const { nodeReadinessFs: fresh } = await import('../readiness');

    const outcome = await fresh().write('/nikde/x.probe', 'ahoj');

    // Pořadí je součást tvrzení: `sync` musí padnout mezi zápis a zavření
    // deskriptoru, jinak vynucuje trvanlivost nad už zavřeným handlem.
    expect(handleCalls).toEqual(['write', 'sync', 'close']);
    expect(outcome).toEqual({ durabilityVerified: false });
  });

  it('svazek, který fsync umí, hlásí ověřeno — a je to týž kód, ne jiná větev', async () => {
    // Rozlišovací polovina: bez ní by aserce nahoře prošla i nad adaptérem,
    // který hlásí `false` vždycky.
    mockFsPromises(false);
    vi.resetModules();
    const { nodeReadinessFs: fresh } = await import('../readiness');

    const outcome = await fresh().write('/nikde/x.probe', 'ahoj');

    expect(handleCalls).toEqual(['write', 'sync', 'close']);
    expect(outcome).toEqual({ durabilityVerified: true });
  });
});

describe('AdmissionPolicy — nesmyslná politika se odmítne při stavbě, ne za běhu', () => {
  // Nález čerstvého recenzenta nad `eee9e1f`. Politika se nekontrolovala nikde,
  // a zrušení `unref()` tu cestu zhoršilo: dřív mohl proces aspoň skončit, teď
  // ho fronta drží a tiká po milisekundě navždy, zatímco čekající verdikt
  // nedostane. Je to táž třída jako čas přijetí zvenčí, jen vyrobená
  // konfigurací — `Number(process.env.BUDGET_MS)` u chybějící proměnné je `NaN`.
  const BAD: ReadonlyArray<readonly [string, AdmissionPolicy]> = [
    ['budgetMs NaN', { budgetMs: Number.NaN, minServiceMs: 2_000, maxQueued: 4 }],
    ['budgetMs Infinity', { budgetMs: Number.POSITIVE_INFINITY, minServiceMs: 2_000, maxQueued: 4 }],
    ['budgetMs záporný', { budgetMs: -1, minServiceMs: 0, maxQueued: 4 }],
    ['budgetMs nulový', { budgetMs: 0, minServiceMs: 0, maxQueued: 4 }],
    ['minServiceMs NaN', { budgetMs: 10_000, minServiceMs: Number.NaN, maxQueued: 4 }],
    ['minServiceMs Infinity', { budgetMs: 10_000, minServiceMs: Number.POSITIVE_INFINITY, maxQueued: 4 }],
    ['minServiceMs záporný', { budgetMs: 10_000, minServiceMs: -1, maxQueued: 4 }],
    ['minServiceMs přes rozpočet', { budgetMs: 1_000, minServiceMs: 1_001, maxQueued: 4 }],
    ['maxQueued NaN', { budgetMs: 10_000, minServiceMs: 2_000, maxQueued: Number.NaN }],
    ['maxQueued záporný', { budgetMs: 10_000, minServiceMs: 2_000, maxQueued: -1 }],
    ['maxQueued zlomek', { budgetMs: 10_000, minServiceMs: 2_000, maxQueued: 1.5 }],
  ];

  it.each(BAD)('%s: fronta se nepostaví', (_label, policy) => {
    const clock = manualClock();

    expect(
      () =>
        new AdmissionQueue(policy, {
          now: clock.now,
          concurrency: 1,
          schedule: clock.schedule,
          onCoercedReceipt: ignoreCoercions,
        }),
    ).toThrow(RangeError);
  });

  it.each(BAD)('%s: `admit()` je exportovaná, takže má tutéž kontrolu', (_label, policy) => {
    // Bez ní vrátí `admit` u `budgetMs: NaN` verdikt `admitted: true` s
    // `deadlineMs: NaN` — deadline, který nikdy nevyprší, předaný dál do práce.
    expect(() => admit('x', 1_000, 1_000, policy)).toThrow(RangeError);
  });

  it('poctivá politika projde, včetně hraničních hodnot na obou koncích', () => {
    // Rozlišovací polovina: bez ní by aserce nahoře prošly i nad kontrolou,
    // která odmítá všechno, a fronta by nešla postavit vůbec.
    const clock = manualClock();

    expect(() => checkPolicy(POLICY)).not.toThrow();
    // `maxQueued: 0` je legitimní — fronta bez čekárny odmítá hned, jakmile je plno.
    expect(() => checkPolicy({ budgetMs: 1, minServiceMs: 0, maxQueued: 0 })).not.toThrow();
    // Minimum přesně na rozpočtu ještě projde; o milisekundu víc už ne.
    expect(() => checkPolicy({ budgetMs: 1_000, minServiceMs: 1_000, maxQueued: 4 })).not.toThrow();
    expect(
      () =>
        new AdmissionQueue(POLICY, {
          now: clock.now,
          concurrency: 1,
          schedule: clock.schedule,
          onCoercedReceipt: ignoreCoercions,
        }),
    ).not.toThrow();
  });
});

describe('AdmissionQueue — zavření zkrátí hold, aniž by kdokoli přišel o verdikt', () => {
  // Nález čerstvého recenzenta nad `eee9e1f`: zrušení `unref()` vyměnilo
  // „proces skončí dřív než verdikt" za „čekající drží proces až do svého
  // vypršení", a tu druhou mez neměl kdo zkrátit. Po `SIGTERM` je to u rozpočtu
  // 60 s celá minuta po zavření posluchače.
  function openQueue(clock: ReturnType<typeof manualClock>): AdmissionQueue {
    return new AdmissionQueue(POLICY, {
      now: clock.now,
      concurrency: 1,
      schedule: clock.schedule,
      onCoercedReceipt: ignoreCoercions,
    });
  }

  it('čekající dostane verdikt hned a NIKDY ne `admitted: true` s prázdnou hodnotou', async () => {
    // Tohle je celý důvod, proč zavření není `expired`: rozpočet ještě neuplynul,
    // takže `admit()` by vrátilo `admitted: true` — a `admitted: true` vedle
    // `value: null` je verdikt, který lže, protože práce se nespustila.
    const clock = manualClock();
    const queue = openQueue(clock);

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    const waiting = queue.submit('waiting', async () => 'nikdy');
    await settle();
    expect(queue.queued).toBe(1);

    queue.close();

    const outcome = await waiting;
    expect(outcome.verdict).toMatchObject({ admitted: false, id: 'waiting', reason: 'SHUTTING_DOWN' });
    expect(outcome.value).toBeNull();
    expect(queue.queued).toBe(0);

    // Běžící práce se nepřerušuje — drží skutečný slot a dokončí se.
    release();
    expect(await busy).toMatchObject({ value: 'hotovo' });
  });

  it('zavřená fronta nepřijímá nic nového a znovu už nikoho nenechá čekat', async () => {
    const clock = manualClock();
    const queue = openQueue(clock);
    queue.close();

    const outcome = await queue.submit('pozdni', async () => 'nikdy');

    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'SHUTTING_DOWN' });
    expect(outcome.value).toBeNull();
    expect(queue.queued).toBe(0);
    // Druhé zavolání nemá koho probudit a nesmí spadnout.
    expect(() => queue.close()).not.toThrow();
  });
});

describe('AdmissionQueue — zavření měřené na procesu, ne na hodinách v testu', () => {
  // Rozšíření podprocesového oracle z T302d, a měří přesně tu mez, kterou
  // `close()` zkracuje. Rozpočet je 60 s schválně: bez funkčního `close()` by
  // čekající držel proces skoro minutu, `spawnSync` by ho po 15 s zabil a
  // nepřišel by ŽÁDNÝ výstup. S ním verdikt dorazí v řádu milisekund.
  it('zavření sundá hold na nulu, i když do vypršení chybí ještě minuta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldsmith-close-'));
    const child = join(dir, 'child.mjs');
    const source = new URL('../admission.ts', import.meta.url).href;

    writeFileSync(
      child,
      [
        `import { AdmissionQueue } from ${JSON.stringify(source)};`,
        'const queue = new AdmissionQueue(',
        '  { budgetMs: 60000, minServiceMs: 1000, maxQueued: 4 },',
        '  { now: () => Date.now(), concurrency: 1, onCoercedReceipt: () => undefined },',
        ');',
        "void queue.submit('busy', () => new Promise(() => undefined));",
        "queue.submit('waiting', async () => 'nikdy').then((outcome) => {",
        '  process.stdout.write(JSON.stringify(outcome.verdict));',
        '});',
        'setImmediate(() => queue.close());',
      ].join('\n'),
      'utf-8',
    );

    try {
      const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', child], {
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(run.stdout.trim(), 'proces držel hold až do vypršení rozpočtu').not.toBe('');
      expect(JSON.parse(run.stdout.trim())).toMatchObject({
        admitted: false,
        id: 'waiting',
        reason: 'SHUTTING_DOWN',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('AdmissionPolicy — konečné číslo nestačí, rozpočet musí být i dost malý', () => {
  // Nález druhé recenze, a je to díra v kontrole z T302f: mez byla jen zdola.
  // Naměřeno — `budgetMs: 2_147_483_648` prošlo `checkPolicy()` a plánovači
  // dorazil odklad 2147483648, který Node ořízne na 1 ms. Tedy přesně ta smyčka,
  // kterou ta kontrola měla zavřít. Commit `da7f62b` navíc smazal clamp
  // v `#armExpiry()` s odůvodněním „ohraničený čas přijetí ho zneplatní" — to
  // krylo `receivedAtMs`, nikdy `budgetMs`, a nikdo ho neměřil.
  it('rozpočet přes nejdelší odklad, který setTimeout umí, se odmítne', () => {
    const tooBig = { budgetMs: MAX_DELAY_MS + 1, minServiceMs: 0, maxQueued: 4 };

    expect(() => checkPolicy(tooBig)).toThrow(RangeError);
    expect(() => admit('x', 1_000, 1_000, tooBig)).toThrow(RangeError);
  });

  it('rozpočet přesně na té hranici projde — mez nesmí ukrojit legitimní nastavení', () => {
    expect(() => checkPolicy({ budgetMs: MAX_DELAY_MS, minServiceMs: 0, maxQueued: 4 })).not.toThrow();
  });

  it('po kontrole je odklad dokazatelně v rozsahu, takže clamp by byl mrtvý kód', async () => {
    // Z `earliestReceipt <= now` plyne `delayMs <= budgetMs - minServiceMs`.
    // Test to měří na největší politice, jakou kontrola pustí — kdyby mez chyběla,
    // tady by se objevilo číslo nad `MAX_DELAY_MS`.
    const delays: number[] = [];
    const clock = manualClock();
    const queue = new AdmissionQueue(
      { budgetMs: MAX_DELAY_MS, minServiceMs: 1, maxQueued: 4 },
      {
        now: clock.now,
        concurrency: 1,
        onCoercedReceipt: ignoreCoercions,
        schedule: (fn, delayMs) => {
          delays.push(delayMs);
          return clock.schedule(fn, delayMs);
        },
      },
    );

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();
    void queue.submit('waiting', async () => 'nikdy');
    await settle();

    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);

    queue.close();
    release();
    await busy;
  });
});

describe('QueueDeps.concurrency — nekontrolovaná soubežnost udělá frontu, co nikdy nic nespustí', () => {
  // Nález druhé recenze: `checkPolicy()` řešilo politiku a o pole vedle stálo
  // `concurrency` bez jakékoli kontroly. `this.#running < NaN` je vždycky
  // nepravda, takže se nepustí nikdo a všechno skončí na `DEADLINE_EXCEEDED`.
  it.each([
    ['NaN', Number.NaN],
    ['nula', 0],
    ['záporná', -1],
    ['zlomek', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s: fronta se nepostaví', (_label, concurrency) => {
    const clock = manualClock();

    expect(
      () =>
        new AdmissionQueue(POLICY, {
          now: clock.now,
          concurrency,
          schedule: clock.schedule,
          onCoercedReceipt: ignoreCoercions,
        }),
    ).toThrow(RangeError);
  });

  it('jedna je legitimní minimum, ne hraniční případ', () => {
    const clock = manualClock();

    expect(
      () =>
        new AdmissionQueue(POLICY, {
          now: clock.now,
          concurrency: 1,
          schedule: clock.schedule,
          onCoercedReceipt: ignoreCoercions,
        }),
    ).not.toThrow();
  });
});

describe('AdmissionQueue — obsluha srovnání smí frontu zavřít, a čekající o verdikt nepřijde', () => {
  // Nález druhé recenze, a **vyvrací odůvodnění, kterým jsem v `77f3b16` smazal
  // podmínku `#closed` z `#armExpiry()`.** Argument „po zavření je čekárna
  // prázdná a `submit` nikoho nového nepustí" neplatil: `onCoercedReceipt` běží
  // synchronně MEZI čtením `#closed` a zařazením do čekárny, takže obsluha, která
  // rozbité hodiny bere jako fatální, tu díru otevře. Naměřeno na re-entrantní
  // obsluze: čekající verdikt nedostal a fronta hlásila `queued: 1`.
  //
  // Oprava ale NENÍ ta smazaná podmínka — ta by časovač nenaplánovala vůbec,
  // takže by čekajícího neprobudil nikdo a z ohraničeného držení procesu by bylo
  // nekonečné. Změřeno taky. Správně je přečíst `#closed` znovu, až po obsluze.
  it('zavření z obsluhy srovnání dá čekajícímu SHUTTING_DOWN, ne mlčení', async () => {
    const clock = manualClock();
    const seen: CoercedReceipt[] = [];
    let queue!: AdmissionQueue;
    queue = new AdmissionQueue(POLICY, {
      now: clock.now,
      concurrency: 1,
      schedule: clock.schedule,
      onCoercedReceipt: (c) => {
        seen.push(c);
        queue.close();
      },
    });

    let release = (): void => undefined;
    const busy = queue.submit('busy', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return 'hotovo';
    });
    await settle();

    // Slot je obsazený, takže bez opravy by se tenhle požadavek zařadil do už
    // vyprázdněné čekárny a verdikt by dostal až po `budgetMs - minServiceMs`.
    const outcome = await queue.submit('obet', async () => 'nikdy', Number.NaN);

    expect(seen).toHaveLength(1);
    expect(outcome.verdict).toMatchObject({ admitted: false, id: 'obet', reason: 'SHUTTING_DOWN' });
    expect(outcome.value).toBeNull();
    expect(queue.queued).toBe(0);

    release();
    await busy;
  });

  it('srovnání během vypínání se hlásí — mlčky se to neděje ani na téhle cestě', async () => {
    // Druhá polovina téhož nálezu: kontrola `#closed` stála PŘED hlášením, takže
    // požadavek, který dorazil do vypínající se fronty s rozbitým časem, se
    // srovnal potichu — čítač se nehnul a obsluha se nedozvěděla nic.
    const clock = manualClock();
    const log = coercionLog();
    const queue = new AdmissionQueue(POLICY, {
      now: clock.now,
      concurrency: 1,
      schedule: clock.schedule,
      onCoercedReceipt: log.onCoercedReceipt,
    });
    queue.close();
    clock.advance(5_000);

    const outcome = await queue.submit('pozdni', async () => 'nikdy', Number.NaN);

    expect(outcome.verdict).toMatchObject({ admitted: false, reason: 'SHUTTING_DOWN' });
    expect(log.seen).toEqual([{ id: 'pozdni', claimedMs: Number.NaN, usedMs: 6_000 }]);
    expect(queue.coercedReceipts).toBe(1);
  });
});
