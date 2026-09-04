import { afterEach, describe, expect, it } from 'vitest';

import {
  BODY_DEADLINE_MS,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_BODY_READS,
  bodyRefusal,
  bodyRefusalResponse,
  openBodyReads,
  readBody,
} from '../body';

/**
 * Požadavek, jehož tělo **mlčí, dokud mu to někdo nedovolí** — tedy přesně ten
 * klient, kvůli kterému mez na počet souběžných čtení vznikla: hlavičky odešly,
 * tělo nikdy nedorazí a slot je obsazený až do deadlinu.
 */
function stalledRequest(): { readonly request: Request; readonly finish: () => void } {
  let finish = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        controller.close();
      };
    },
  });
  const request = new Request('http://worldsmith.test/api/edit', {
    method: 'POST',
    body,
    // Node vyžaduje u proudového těla `duplex`; v typech `RequestInit` není.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { request, finish: () => { finish(); } };
}

describe('strop na počet souběžných čtení těla', () => {
  afterEach(() => {
    // Čítač visí na `globalThis`, takže netěsnost jednoho případu by se
    // projevila až v jiném. Když tohle zčervená, je vada tady, ne tam.
    expect(openBodyReads(), 'čtení zůstalo otevřené po konci případu').toBe(0);
  });

  it('pustí přesně tolik čtení, kolik říká mez, a další odmítne bez čtení', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS }, stalledRequest);
    // Slot se bere **synchronně**, dřív než se sáhne na proud — jinak by mez
    // platila až po prvním `await` a N klientů by se do ní vešlo naráz.
    const pending = held.map((h) => readBody(h.request, 60_000));
    expect(openBodyReads()).toBe(MAX_CONCURRENT_BODY_READS);

    const extra = stalledRequest();
    expect(await readBody(extra.request)).toEqual({ ok: false, reason: 'BUSY' });

    for (const h of held) h.finish();
    expect(await Promise.all(pending)).toHaveLength(MAX_CONCURRENT_BODY_READS);
    expect(openBodyReads()).toBe(0);
  });

  it('slot se vrátí i tehdy, když čtení VYHODÍ, ne jen když doběhne', async () => {
    // **Failure path, a je to ta drahá půlka.** Kdyby se čítač snižoval až na
    // šťastné cestě, každé přerušené spojení nebo vadná komprese by mez utáhly
    // o jedna natrvalo — po 32 takových požadavcích by server odmítal všechno
    // a v logu by to vypadalo jako nápor.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('spojení se přetrhlo'));
      },
    });
    const request = new Request('http://worldsmith.test/api/edit', {
      method: 'POST',
      body,
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

  it('mez je součin dvou mezí nad ní, ne volné číslo', () => {
    // Kdo zvedne počet, zvedne i strop paměti, kterou čtená těla naráz drží.
    // Pinuje se ten součin, aby se to číslo nedalo posunout mlčky.
    expect(MAX_CONCURRENT_BODY_READS * MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('překlad odmítnutého čtení na odpověď', () => {
  it('tři důvody dají tři různé stavy a kódy', () => {
    expect(bodyRefusal('TOO_LARGE')).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(bodyRefusal('TIMEOUT')).toMatchObject({ status: 408, code: 'BODY_TIMEOUT' });
    expect(bodyRefusal('BUSY')).toMatchObject({ status: 429, code: 'TOO_MANY_BODY_READS' });
  });

  it('nápor NENÍ pomalé tělo — 429, ne 408', () => {
    // **Vada, kterou přibytí třetího důvodu odhalilo na čtyřech místech naráz.**
    // `reason === 'TOO_LARGE' ? 413 : 408` vydá na plnou frontu 408 „tělo
    // dorazilo pomalu", což je tvrzení o volajícím — a ten neudělal nic.
    expect(bodyRefusal('BUSY').status).not.toBe(bodyRefusal('TIMEOUT').status);
    expect(bodyRefusal('BUSY').code).not.toBe(bodyRefusal('TIMEOUT').code);
  });

  it('opakovat má smysl jen u naplněné fronty, a čeká se odvozenou dobu', () => {
    // Pět sekund není vybraných: `BODY_DEADLINE_MS` ručí, že se obsazený slot
    // do té doby uvolní i proti mlčícímu klientovi.
    expect(bodyRefusal('BUSY').retryAfterSeconds).toBe(Math.ceil(BODY_DEADLINE_MS / 1000));
    expect(bodyRefusal('TOO_LARGE').retryAfterSeconds).toBeUndefined();
    expect(bodyRefusal('TIMEOUT').retryAfterSeconds).toBeUndefined();
  });

  it('odpověď nese requestId, kód i hlavičku retry-after', async () => {
    const busy = bodyRefusalResponse('req-1', 'BUSY');
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(await busy.json()).toEqual({
      requestId: 'req-1',
      error: { code: 'TOO_MANY_BODY_READS', message: 'too many request bodies are being read right now' },
    });

    // Hlavička se posílá jen tam, kde opakování pomůže — u těla přes strop by
    // slibovala, že za pět sekund projde totéž tělo, které projít nemůže.
    const tooLarge = bodyRefusalResponse('req-2', 'TOO_LARGE');
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('retry-after')).toBeNull();
  });

  it('kódy a hlášky dvou starších důvodů se nezměnily', () => {
    // Kontrakt `/api/emit`, `/api/edit` a `/api/generate` je čte; tahle úloha
    // objednala třetí důvod, ne přejmenování dvou stávajících.
    expect(bodyRefusal('TOO_LARGE').message).toBe(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`);
    expect(bodyRefusal('TIMEOUT').message).toBe(
      `request body did not arrive within ${String(BODY_DEADLINE_MS)} ms`,
    );
  });
});
