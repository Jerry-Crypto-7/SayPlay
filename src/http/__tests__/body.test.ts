import { afterEach, describe, expect, it } from 'vitest';

import {
  BODY_DEADLINE_MS,
  MAX_BODY_BYTES,
  MAX_BUFFERED_BODY_BYTES,
  MAX_CONCURRENT_BODY_READS_PER_CALLER,
  MAX_CONCURRENT_BODY_READS_UNIDENTIFIED,
  bodyRefusal,
  bodyRefusalResponse,
  bufferedBodyBytes,
  openBodyReads,
  readBody,
  trackedBodyCallers,
} from '../body';

/**
 * Požadavek, jehož tělo **posílá jen to, co mu někdo řekne** — tedy přesně ten
 * klient, kvůli kterému obě meze na souběh vznikly: hlavičky odešly, tělo
 * chodí po kusech nebo vůbec, a slot je obsazený až do deadlinu.
 */
function pushableRequest(caller?: string): {
  readonly request: Request;
  readonly push: (bytes: number) => void;
  readonly finish: () => void;
} {
  let push = (_bytes: number): void => undefined;
  let close = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (bytes) => {
        controller.enqueue(new Uint8Array(bytes));
      };
      close = () => {
        controller.close();
      };
    },
  });
  const request = new Request('http://worldsmith.test/api/edit', {
    method: 'POST',
    body,
    ...(caller === undefined ? {} : { headers: { 'x-forwarded-for': caller } }),
    // Node vyžaduje u proudového těla `duplex`; v typech `RequestInit` není.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return {
    request,
    push: (bytes) => {
      push(bytes);
    },
    finish: () => {
      close();
    },
  };
}

/**
 * Bajty se do rozpočtu dostávají **asynchronně** — mezi `readBody()` a prvním
 * přečteným kusem je pár taktů smyčky. Čekat pevný `setTimeout` je závod;
 * tohle čeká na stav a spadne s hláškou, ne timeoutem celé sady.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`nedočkal jsem se: ${what} (drží ${String(bufferedBodyBytes())} B)`);
}

/** Kolik plných těl se vejde do rozpočtu instance. 32 při dnešních číslech. */
const READS_TO_FILL_BUDGET = MAX_BUFFERED_BODY_BYTES / MAX_BODY_BYTES;

/**
 * Naplnit rozpočet instance po `shortBy` bajtů. Volajících je tolik, kolik jich
 * je potřeba — jeden sám na to nestačí a **to je ta vlastnost**, ne omezení
 * testu.
 */
function fillBudget(shortBy = 0): {
  readonly held: readonly { readonly finish: () => void }[];
  readonly pending: readonly Promise<unknown>[];
} {
  const held: { readonly push: (bytes: number) => void; readonly finish: () => void }[] = [];
  const pending: Promise<unknown>[] = [];
  for (let read = 0; read < READS_TO_FILL_BUDGET; read += 1) {
    const caller = `10.0.0.${String(Math.floor(read / MAX_CONCURRENT_BODY_READS_PER_CALLER))}`;
    const holder = pushableRequest(caller);
    held.push(holder);
    pending.push(readBody(holder.request, 60_000));
    holder.push(read === 0 ? MAX_BODY_BYTES - shortBy : MAX_BODY_BYTES);
  }
  return { held, pending };
}

describe('strop na počet souběžných čtení jednoho volajícího', () => {
  afterEach(() => {
    // Obojí visí na `globalThis`, takže netěsnost jednoho případu by se
    // projevila až v jiném. Když tohle zčervená, je vada tady, ne tam.
    expect(openBodyReads(), 'čtení zůstalo otevřené po konci případu').toBe(0);
    expect(bufferedBodyBytes(), 'bajty zůstaly v rozpočtu po konci případu').toBe(0);
    expect(trackedBodyCallers(), 'volající zůstal v mapě po konci případu').toBe(0);
  });

  it('pustí přesně tolik čtení, kolik říká mez, a další od TÉHOŽ volajícího odmítne', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_PER_CALLER }, () =>
      pushableRequest('203.0.113.7'),
    );
    // Slot se bere **synchronně**, dřív než se sáhne na proud — jinak by mez
    // platila až po prvním `await` a N klientů by se do ní vešlo naráz.
    const pending = held.map((h) => readBody(h.request, 60_000));
    expect(openBodyReads()).toBe(MAX_CONCURRENT_BODY_READS_PER_CALLER);

    const extra = pushableRequest('203.0.113.7');
    expect(await readBody(extra.request)).toEqual({ ok: false, reason: 'BUSY', scope: 'caller' });

    for (const h of held) h.finish();
    expect(await Promise.all(pending)).toHaveLength(MAX_CONCURRENT_BODY_READS_PER_CALLER);
    expect(openBodyReads()).toBe(0);
  });

  it('plný volající NEZAVŘE dveře nikomu jinému', async () => {
    // **Tohle je celý důvod, proč je klíč volající.** Do 4. 9. 2026 tu byl
    // jeden čítač na proces: čtyři mlčící spojení by tehdy vzala slot i tomu,
    // kdo poslal první požadavek.
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_PER_CALLER }, () =>
      pushableRequest('198.51.100.1'),
    );
    const pending = held.map((h) => readBody(h.request, 60_000));

    const other = pushableRequest('198.51.100.2');
    const otherRead = readBody(other.request, 60_000);
    expect(openBodyReads()).toBe(MAX_CONCURRENT_BODY_READS_PER_CALLER + 1);
    other.finish();
    expect(await otherRead).toEqual({ ok: true, text: '' });

    for (const h of held) h.finish();
    await Promise.all(pending);
  });

  it('sto mlčících spojení z podvržených adres nezavře dveře nikomu', async () => {
    // **Naměřená regrese `cdde072`.** Globální strop na POČET čtení tohle
    // pustit nesměl: mlčící spojení dodá nula bajtů, takže paměť nestojí nic
    // a odmítat kvůli němu znamená obranu levnější než útok.
    const silent = Array.from({ length: 100 }, (_unused, index) =>
      pushableRequest(`192.0.2.${String(index)}`),
    );
    const pending = silent.map((h) => readBody(h.request, 60_000));
    expect(openBodyReads()).toBe(100);
    expect(bufferedBodyBytes(), 'kdo mlčí, nedrží ani bajt').toBe(0);

    const guest = pushableRequest('203.0.113.9');
    const guestRead = readBody(guest.request, 60_000);
    guest.push(16);
    guest.finish();
    expect((await guestRead).ok).toBe(true);

    for (const h of silent) h.finish();
    await Promise.all(pending);
  });

  it('doběhlé čtení vrátí JEDEN slot, ne celý záznam volajícího', async () => {
    // **Mutant, který přežil první kolo** (nezávislá revize 4. 9. 2026):
    // nahradit celý dekrement za `perCaller.delete(caller)` prošlo všemi
    // testy, protože každý z nich svá souběžná čtení zavíral naráz. Takový
    // kód strop ruší úplně — komu doběhne jedno ze čtyř, smí otevřít další
    // čtyři. Tenhle případ proto **jedno** zavře a tři nechá viset.
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_PER_CALLER }, () =>
      pushableRequest('203.0.113.31'),
    );
    const pending = held.map((h) => readBody(h.request, 60_000));
    try {
      const [first, ...rest] = held;
      first.finish();
      expect(await pending[0]).toEqual({ ok: true, text: '' });
      expect(openBodyReads(), 'zavřelo se jedno čtení, ne všechna').toBe(rest.length);

      // Uvolnil se právě jeden slot, takže právě jedno nové čtení projde…
      const admitted = pushableRequest('203.0.113.31');
      const admittedRead = readBody(admitted.request, 60_000);
      // …a hned to další už ne. Kdyby se mazal celý záznam, prošla by obě.
      const refused = pushableRequest('203.0.113.31');
      expect(await readBody(refused.request)).toEqual({
        ok: false,
        reason: 'BUSY',
        scope: 'caller',
      });

      admitted.finish();
      await admittedRead;
    } finally {
      for (const h of held.slice(1)) h.finish();
      await Promise.all(pending);
    }
  });

  it('slot se vrátí i tehdy, když čtení VYHODÍ, ne jen když doběhne', async () => {
    // **Failure path, a je to ta drahá půlka.** Kdyby se čítač snižoval až na
    // šťastné cestě, každé přerušené spojení nebo vadná komprese by mez utáhly
    // o jedna natrvalo — po čtyřech takových požadavcích by volající dostával
    // 429 napořád a v logu by to vypadalo jako nápor.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('spojení se přetrhlo'));
      },
    });
    const request = new Request('http://worldsmith.test/api/edit', {
      method: 'POST',
      body,
      headers: { 'x-forwarded-for': '203.0.113.11' },
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readBody(request)).rejects.toThrow('spojení se přetrhlo');
    expect(openBodyReads()).toBe(0);
  });

  it('požadavek bez těla si slot nebere', async () => {
    // Držet by neměl co, a odmítnout ho kvůli plné čtecí frontě by byla mez
    // na něčem, co tu frontu nezatěžuje.
    const request = new Request('http://worldsmith.test/api/edit', { method: 'POST' });
    expect(await readBody(request)).toEqual({ ok: true, text: '' });
    expect(openBodyReads()).toBe(0);
  });

  it('běh bez proxy nezavře dveře čtyřmi mlčícími spojeními', async () => {
    // **Regrese naměřená nezávislou revizí 4. 9. 2026.** Bez hlaviček proxy
    // spadnou všichni do jednoho klíče, takže strop 4 by byl mez na celý
    // proces — osmkrát přísnější než 32, které nahradil, a čtyři mlčící
    // spojení by zavřela dveře komukoli. Žádná hlavička = žádná izolace,
    // takže tam per-caller mez neplatí.
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_PER_CALLER + 1 }, () =>
      pushableRequest(),
    );
    const pending = held.map((h) => readBody(h.request, 60_000));
    try {
      expect(openBodyReads(), 'pátý nerozeznaný požadavek se odmítl').toBe(held.length);

      const guest = pushableRequest();
      const guestRead = readBody(guest.request, 60_000);
      guest.push(16);
      guest.finish();
      expect((await guestRead).ok).toBe(true);
    } finally {
      for (const h of held) h.finish();
      await Promise.all(pending);
    }
  });

  it('plný kbelík nerozeznaných je odmítnutí instance, ne obvinění volajícího', async () => {
    // V jednom kbelíku není koho od koho izolovat, takže „posíláš jich moc ty"
    // by bylo tvrzení o volajícím, který za jeho naplnění nemusí moci.
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_UNIDENTIFIED }, () =>
      pushableRequest(),
    );
    const pending = held.map((h) => readBody(h.request, 60_000));
    try {
      expect(await readBody(pushableRequest().request)).toEqual({
        ok: false,
        reason: 'BUSY',
        scope: 'instance',
      });
    } finally {
      for (const h of held) h.finish();
      await Promise.all(pending);
    }
  });

  it('strop nerozeznaných je to, co unese paměť — ne nové volné číslo', () => {
    // Odvozený, ne vybraný: přesně tolik plných těl, kolik drží rozpočet, tedy
    // chování před rozdělením meze.
    expect(MAX_CONCURRENT_BODY_READS_UNIDENTIFIED * MAX_BODY_BYTES).toBe(MAX_BUFFERED_BODY_BYTES);
    expect(
      MAX_CONCURRENT_BODY_READS_UNIDENTIFIED,
      'kbelík bez izolace nesmí být přísnější než rozeznaný volající',
    ).toBeGreaterThan(MAX_CONCURRENT_BODY_READS_PER_CALLER);
  });

  it('jeden volající sám rozpočet instance nezaplní', () => {
    // Součin, ne vkus: čtyři plná těla jsou osmina rozpočtu, takže na jeho
    // naplnění je potřeba osm různých adres. Kdo zvedne počet, zvedá i tohle.
    expect(MAX_CONCURRENT_BODY_READS_PER_CALLER * MAX_BODY_BYTES).toBe(
      MAX_BUFFERED_BODY_BYTES / 8,
    );
  });
});

describe('rozpočet bajtů na instanci', () => {
  afterEach(() => {
    expect(openBodyReads(), 'čtení zůstalo otevřené po konci případu').toBe(0);
    expect(bufferedBodyBytes(), 'bajty zůstaly v rozpočtu po konci případu').toBe(0);
  });

  it('plný rozpočet odmítne další čtení, aniž na proud sáhne', async () => {
    const { held, pending } = fillBudget();
    try {
      await until(
        () => bufferedBodyBytes() === MAX_BUFFERED_BODY_BYTES,
        'rozpočet se naplnil na plno',
      );

      // Proud tohohle požadavku se nikdy nezavře — a `readBody` přesto
      // odpoví. To je ta vlastnost: odmítnutí stojí nula čtení.
      const extra = pushableRequest('10.9.9.9');
      expect(await readBody(extra.request, 60_000)).toEqual({
        ok: false,
        reason: 'BUSY',
        scope: 'instance',
      });
    } finally {
      for (const h of held) h.finish();
      await Promise.all(pending);
    }
  });

  it('rozpočet se soudí i UPROSTŘED čtení, ne jen při vpuštění', async () => {
    // **Bez tohohle by rozpočet neohraničoval nic.** Vlna spojení projde, dokud
    // je rozpočet prázdný, a teprve pak začne posílat — kontrola při vpuštění
    // je v ten okamžik dávno za nimi.
    const { held, pending } = fillBudget(2);
    try {
      await until(
        () => bufferedBodyBytes() === MAX_BUFFERED_BODY_BYTES - 2,
        'rozpočet se naplnil až na dva bajty',
      );

      const late = pushableRequest('10.9.9.8');
      const lateRead = readBody(late.request, 60_000);
      // Vpuštěné čtení: v okamžiku vpuštění se do rozpočtu ještě vešlo.
      expect(openBodyReads()).toBe(READS_TO_FILL_BUDGET + 1);
      late.push(3);
      late.finish();

      expect(await lateRead).toEqual({ ok: false, reason: 'BUSY', scope: 'instance' });
      // A svoje bajty vrátilo, takže plnou instanci nedrží zavřenou navíc.
      expect(bufferedBodyBytes()).toBe(MAX_BUFFERED_BODY_BYTES - 2);
    } finally {
      for (const h of held) h.finish();
      await Promise.all(pending);
    }
  });

  it('tělo přes strop velikosti vrátí bajty HNED, ne až na konci čtení', async () => {
    // Kdyby se vracely až v `finally`, držel by rozpočet 64 kB za tělo, které
    // je dávno zahozené — a útok „pošli o bajt víc" by byl nejlevnější způsob,
    // jak instanci ucpat.
    const holder = pushableRequest('203.0.113.20');
    const read = readBody(holder.request, 60_000);
    holder.push(MAX_BODY_BYTES);
    await until(() => bufferedBodyBytes() === MAX_BODY_BYTES, 'plné tělo se započítalo');

    holder.push(1);
    await until(() => bufferedBodyBytes() === 0, 'zahozené tělo vrátilo bajty');

    holder.finish();
    expect(await read).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });
});

describe('překlad odmítnutého čtení na odpověď', () => {
  it('čtyři důvody dají čtyři různé dvojice stavu a kódu', () => {
    expect(bodyRefusal({ reason: 'TOO_LARGE' })).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(bodyRefusal({ reason: 'TIMEOUT' })).toMatchObject({ status: 408, code: 'BODY_TIMEOUT' });
    expect(bodyRefusal({ reason: 'BUSY', scope: 'caller' })).toMatchObject({
      status: 429,
      code: 'TOO_MANY_BODY_READS',
    });
    expect(bodyRefusal({ reason: 'BUSY', scope: 'instance' })).toMatchObject({
      status: 429,
      code: 'SERVER_AT_CAPACITY',
    });
  });

  it('nápor NENÍ pomalé tělo — 429, ne 408', () => {
    // **Vada, kterou přibytí třetího důvodu odhalilo na čtyřech místech naráz.**
    // `reason === 'TOO_LARGE' ? 413 : 408` vydá na plnou frontu 408 „tělo
    // dorazilo pomalu", což je tvrzení o volajícím — a ten neudělal nic.
    const busy = bodyRefusal({ reason: 'BUSY', scope: 'caller' });
    const timeout = bodyRefusal({ reason: 'TIMEOUT' });
    expect(busy.status).not.toBe(timeout.status);
    expect(busy.code).not.toBe(timeout.code);
  });

  it('plná instance neobviní volajícího z toho, že posílá moc', () => {
    // Druhá půlka téhož nálezu, o patro výš: kdo poslal svůj první požadavek
    // do plné instance, nesmí se dozvědět, že jich posílá moc.
    const mine = bodyRefusal({ reason: 'BUSY', scope: 'caller' });
    const capacity = bodyRefusal({ reason: 'BUSY', scope: 'instance' });
    expect(capacity.code).not.toBe(mine.code);
    expect(capacity.message).not.toBe(mine.message);
    expect(mine.message, 'volajícímu se říká, že střílí on').toContain('this client');
    expect(capacity.message, 'plná instance nesmí ukazovat na volajícího').not.toContain(
      'this client',
    );
    // Zvenčí je to táž situace jako naplněný strop frekvence, takže i táž
    // slova — viz `rateLimitedResponse()` v `src/server/rate-limit.ts`.
    expect(capacity.message).toBe('this instance is at capacity right now');
  });

  it('opakovat má smysl jen u obou naplněných mezí, a čeká se odvozenou dobu', () => {
    // Pět sekund není vybraných: `BODY_DEADLINE_MS` ručí, že se obsazený slot
    // i držené bajty do té doby uvolní i proti mlčícímu klientovi.
    const seconds = Math.ceil(BODY_DEADLINE_MS / 1000);
    expect(bodyRefusal({ reason: 'BUSY', scope: 'caller' }).retryAfterSeconds).toBe(seconds);
    expect(bodyRefusal({ reason: 'BUSY', scope: 'instance' }).retryAfterSeconds).toBe(seconds);
    expect(bodyRefusal({ reason: 'TOO_LARGE' }).retryAfterSeconds).toBeUndefined();
    expect(bodyRefusal({ reason: 'TIMEOUT' }).retryAfterSeconds).toBeUndefined();
  });

  it('odpověď nese requestId, kód i hlavičku retry-after', async () => {
    const busy = bodyRefusalResponse('req-1', { reason: 'BUSY', scope: 'caller' });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(await busy.json()).toEqual({
      requestId: 'req-1',
      error: { code: 'TOO_MANY_BODY_READS', message: 'too many request bodies from this client' },
    });

    const capacity = bodyRefusalResponse('req-3', { reason: 'BUSY', scope: 'instance' });
    expect(capacity.status).toBe(429);
    expect(await capacity.json()).toEqual({
      requestId: 'req-3',
      error: { code: 'SERVER_AT_CAPACITY', message: 'this instance is at capacity right now' },
    });

    // Hlavička se posílá jen tam, kde opakování pomůže — u těla přes strop by
    // slibovala, že za pět sekund projde totéž tělo, které projít nemůže.
    const tooLarge = bodyRefusalResponse('req-2', { reason: 'TOO_LARGE' });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('retry-after')).toBeNull();
  });

  it('kódy a hlášky dvou starších důvodů se nezměnily', () => {
    // Kontrakt `/api/emit`, `/api/edit` a `/api/generate` je čte; tahle úloha
    // objednala rozdělení `BUSY`, ne přejmenování dvou stávajících.
    expect(bodyRefusal({ reason: 'TOO_LARGE' }).message).toBe(
      `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
    );
    expect(bodyRefusal({ reason: 'TIMEOUT' }).message).toBe(
      `request body did not arrive within ${String(BODY_DEADLINE_MS)} ms`,
    );
  });
});
