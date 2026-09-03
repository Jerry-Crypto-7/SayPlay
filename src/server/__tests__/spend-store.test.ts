import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LEDGER_TIMEOUT_MS,
  httpLedger,
  isServerless,
  ledgerFromEnv,
  storePrefix,
  memoryLedger,
  processLedger,
  resetProcessLedger,
} from '../spend-store';

/**
 * Odpověď roury úložiště. Tvar je `[{result}, {result}]` v pořadí příkazů,
 * tedy nejdřív dolary, pak počet volání.
 */
function pipelineAnswer(usd: number, calls: number): Response {
  return new Response(JSON.stringify([{ result: String(usd) }, { result: calls }]), {
    headers: { 'content-type': 'application/json' },
  });
}

const STORE_ENV = {
  WORLDSMITH_SPEND_STORE_URL: 'https://ledger.example.com',
  WORLDSMITH_SPEND_STORE_TOKEN: 'token',
};

describe('kniha v paměti — kontrakt, na kterém stojí i ten síťový', () => {
  it('vrací součty PO změně, ne před ní', async () => {
    const ledger = memoryLedger();
    expect(await ledger.add(0.25, 1)).toEqual({ usd: 0.25, calls: 1 });
    expect(await ledger.add(0.25, 1)).toEqual({ usd: 0.5, calls: 2 });
  });

  it('záporné přičtení je vrácení rezervace, ne chyba', async () => {
    const ledger = memoryLedger();
    await ledger.add(1, 1);
    expect(await ledger.add(-1, -1)).toEqual({ usd: 0, calls: 0 });
  });

  /**
   * **Tohle je ta vada, kvůli které celý port existuje.**
   *
   * „Přečti, rozmysli, zapiš" pustí poslední kredit dvakrát: mezi čtení a zápis
   * se vejde souběžný požadavek a oba vidí týž zůstatek. `add()` je proti tomu
   * jedna operace, takže dva souběžní dostanou dvě různá čísla a jen jeden
   * z nich může být ten, který se pod strop vešel.
   */
  it('dva souběžné požadavky na poslední kredit nedostanou tentýž součet', async () => {
    const ledger = memoryLedger();
    const [first, second] = await Promise.all([ledger.add(1, 1), ledger.add(1, 1)]);
    expect([first.usd, second.usd].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([first.calls, second.calls].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('kniha procesu je jedna, i když se o ni řekne dvakrát', () => {
  afterEach(() => {
    resetProcessLedger();
  });

  it('sdílí stav, ne jen referenci', async () => {
    await processLedger().add(2, 1);
    // Kdyby druhé volání vracelo novou knihu, tohle je nula — a strop procesu
    // by přestal být strop procesu.
    expect(await processLedger().add(0, 0)).toEqual({ usd: 2, calls: 1 });
  });

  it('reset ji vrátí na nulu, aby si testy nepřenášely zůstatek', async () => {
    await processLedger().add(2, 1);
    resetProcessLedger();
    expect(await processLedger().add(0, 0)).toEqual({ usd: 0, calls: 0 });
  });
});

describe('kniha přes REST', () => {
  it('pošle obě přičtení JEDNOU rourou, ne dvěma lety', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0.5, 2));
    const ledger = httpLedger(
      { url: 'https://ledger.example.com', token: 'token', prefix: 'p', timeoutMs: 1000 },
      fetchImpl,
    );

    expect(await ledger.add(0.5, 1)).toEqual({ usd: 0.5, calls: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ledger.example.com/pipeline');
    expect(JSON.parse(String(init?.body))).toEqual([
      ['INCRBYFLOAT', 'p:usd', '0.5'],
      ['INCRBY', 'p:calls', '1'],
    ]);
  });

  it('klíč jde v hlavičce, ne v adrese', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0, 0));
    await httpLedger(
      { url: 'https://ledger.example.com', token: 'tajny-token', prefix: 'p', timeoutMs: 1000 },
      fetchImpl,
    ).add(0, 0);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain('tajny-token');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tajny-token');
  });

  it('má časový limit — bez něj by výpadek úložiště zavěsil požadavek', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0, 0));
    await httpLedger(
      { url: 'https://ledger.example.com', token: 'token', prefix: 'p', timeoutMs: 1234 },
      fetchImpl,
    ).add(0, 0);

    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * Selhání se hlásí **výjimkou**, protože strop ji překládá na odmítnutí.
   * Kdyby kniha při chybě vracela nuly nebo poslední známý součet, byl by
   * výpadek úložiště způsob, jak strop vypnout.
   */
  it('nepovedená odpověď vyhodí, a bez těla odpovědi', async () => {
    const failing = vi.fn<typeof fetch>(
      async () => new Response('adresa i klic pozadavku jsou v tehle strance', { status: 500 }),
    );
    const ledger = httpLedger(
      { url: 'https://ledger.example.com', token: 'token', prefix: 'p', timeoutMs: 1000 },
      failing,
    );

    // Text výjimky jde do logu operátora. Tělo chybové stránky úložiště v něm
    // být nesmí — nese adresu i klíč požadavku.
    await expect(ledger.add(1, 1)).rejects.toThrow(/answered 500/);
    await expect(ledger.add(1, 1)).rejects.not.toThrow(/adresa i klic/);
  });

  it('odpověď, které nesedí tvar nebo čísla, taky vyhodí', async () => {
    const shapes = [
      '{"result":1}',
      '[{"result":1}]',
      '[{"result":"nic"},{"result":1}]',
      '[{"result":1},{"result":"nic"}]',
    ];
    for (const body of shapes) {
      const ledger = httpLedger(
        { url: 'https://ledger.example.com', token: 'token', prefix: 'p', timeoutMs: 1000 },
        vi.fn<typeof fetch>(
          async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
        ),
      );
      await expect(ledger.add(1, 1), `${body} prošlo`).rejects.toThrow();
    }
  });
});

describe('kniha podle prostředí — a `null` znamená ODMÍTAT', () => {
  afterEach(() => {
    resetProcessLedger();
  });

  it('vyplněná adresa a token dají knihu přes REST', () => {
    expect(ledgerFromEnv(STORE_ENV)?.id).toBe('http');
  });

  it('koncové lomítko v adrese roura nepřidá dvakrát', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0, 0));
    await ledgerFromEnv(
      { ...STORE_ENV, WORLDSMITH_SPEND_STORE_URL: 'https://ledger.example.com//' },
      fetchImpl,
    )?.add(0, 0);

    expect(fetchImpl.mock.calls[0][0]).toBe('https://ledger.example.com/pipeline');
  });

  it('mimo serverless a bez úložiště je to kniha procesu, poctivě označená', () => {
    expect(ledgerFromEnv({})?.id).toBe('process-memory');
  });

  /**
   * **Zavřené selhání, a je to celý smysl `ledgerFromEnv()`.**
   *
   * Do 3. 9. 2026 bránil nasazení s klíčem a bez sdíleného stavu jen komentář
   * v `.env.example`. Strop, který se resetuje s každým chladným startem, je
   * horší než žádný: tváří se, že platí.
   */
  it('na serverless bez úložiště nevydá žádnou knihu', () => {
    expect(ledgerFromEnv({ VERCEL: '1' })).toBeNull();
    // I prázdné a bílé hodnoty jsou „nenastaveno" — jinak by `URL= ` v panelu
    // hostingu vypadalo jako nakonfigurované úložiště.
    expect(
      ledgerFromEnv({
        VERCEL: '1',
        WORLDSMITH_SPEND_STORE_URL: '  ',
        WORLDSMITH_SPEND_STORE_TOKEN: '',
      }),
    ).toBeNull();
  });

  it('na serverless SE úložištěm kniha vznikne', () => {
    expect(ledgerFromEnv({ ...STORE_ENV, VERCEL: '1' })?.id).toBe('http');
  });

  it('`VERCEL` je ta proměnná, podle které se pozná serverless', () => {
    expect(isServerless({ VERCEL: '1' })).toBe(true);
    // Platforma ji nastavuje na všech prostředích, takže i prázdná hodnota
    // znamená „jsme tam". Chybějící proměnná je jediné „nejsme".
    expect(isServerless({ VERCEL: '' })).toBe(true);
    expect(isServerless({})).toBe(false);
  });

  it('výchozí předponu jde přepsat, aby si dvě nasazení nesečetla rozpočty', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0, 0));
    await ledgerFromEnv({ ...STORE_ENV, WORLDSMITH_SPEND_STORE_PREFIX: 'demo' }, fetchImpl)?.add(1, 1);

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))[0][1]).toBe('demo:usd');
  });

  it('preview a produkce dostanou dva různé klíče i bez výslovné předpony', () => {
    // **Naměřená vada, ne teorie:** Vercel nastavuje `VERCEL` i na preview a
    // proměnné prostředí se mezi prostředími běžně sdílejí, takže push feature
    // branche účtoval do téhož klíče jako produkční demo — a rozpočet, na
    // kterém stojí odevzdání, by vyčerpal někdo, kdo si zkoušel větev.
    const production = storePrefix({ VERCEL: '1', VERCEL_ENV: 'production' });
    const preview = storePrefix({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'features/p11-prekladac-svetu',
    });

    expect(production).toBe('worldsmith:spend');
    expect(preview).toBe('worldsmith:spend:preview');

    // **Odděluje se prostředí, NE větev — a to je tvrzení, ne detail.**
    // Nález revize: klíč na větev znamená čerstvý rozpočet na větev, a počet
    // větví neomezuje nic, takže kdo umí pushnout, koupí si další rozpočet
    // přejmenováním. Klíče proto musí být nejvýš dva.
    expect(
      storePrefix({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'jina-vetev' }),
      'větev si vyrobila vlastní rozpočet',
    ).toBe(preview);
  });

  it('chybějící VERCEL_ENV na serverless není produkce, ale neznámo', () => {
    // Systémové proměnné se dají v projektu vypnout přepínačem, který v tomhle
    // repu nebydlí. Spadnout mlčky na produkční klíč je přesně ta vada, kterou
    // úloha zavírá — takové nasazení proto dostane vlastní knihu.
    expect(storePrefix({ VERCEL: '1' })).toBe('worldsmith:spend:unknown-env');
    expect(storePrefix({ VERCEL: '1', VERCEL_ENV: '  ' })).toBe('worldsmith:spend:unknown-env');
    // Mimo Vercel je jediné nasazení norma, tam holý základ platí dál.
    expect(storePrefix({})).toBe('worldsmith:spend');
  });

  it('výslovná předpona vyhrává nad odvozenou, a produkce si nechá holý základ', () => {
    // Odvození je záchranná síť, ne pravidlo: kdo předponu nastaví, dostane ji.
    expect(
      storePrefix({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'x', WORLDSMITH_SPEND_STORE_PREFIX: 'demo' }),
    ).toBe('demo');
    // Mimo Vercel žádné `VERCEL_ENV` není a kniha se nesmí přejmenovat pod
    // běžícím nasazením — proto tentýž holý základ jako produkce.
    expect(storePrefix({})).toBe('worldsmith:spend');
    // Bílé znaky jsou „nenastaveno", stejně jako u adresy a tokenu výš.
    expect(storePrefix({ VERCEL_ENV: 'preview', WORLDSMITH_SPEND_STORE_PREFIX: '  ' })).toBe(
      'worldsmith:spend:preview',
    );
  });

  it('jméno prostředí se vyčistí, aby nerozmazalo strukturu klíče', () => {
    // Klíč je oddělený dvojtečkou (`…:usd`, `…:calls`), takže hodnota
    // s dvojtečkou by ji rozmazala a mohla by mířit na cizí knihu.
    expect(storePrefix({ VERCEL_ENV: 'staging:usd nasty/#' })).toBe(
      'worldsmith:spend:staging-usd-nasty--',
    );
    // Ohraničená délka: klíč nesmí růst s tím, co kdo do proměnné napíše.
    expect(storePrefix({ VERCEL_ENV: 'a'.repeat(500) }).length).toBeLessThan(120);
  });

  it('odvozená předpona doopravdy dojde do klíčů, ne jen do návratové hodnoty', async () => {
    // Bez tohohle by `storePrefix` mohla být správná a `ledgerFromEnv` ji
    // přesto nepoužít — což je přesně ta vada, kterou úloha zavírá.
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0, 0));
    await ledgerFromEnv(
      { ...STORE_ENV, VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'vetev' },
      fetchImpl,
    )?.add(1, 1);

    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as string[][];
    expect(sent[0][1]).toBe('worldsmith:spend:preview:usd');
    expect(sent[1][1]).toBe('worldsmith:spend:preview:calls');
  });

  it('časový limit je pod rozpočtem hrubého světa, ne nad ním', () => {
    // §22.1 dává na hrubý svět 3 s. Kdyby si čekání na knihu vzalo víc,
    // byl by strop sám tím, co rozpočet přetáhne.
    expect(DEFAULT_LEDGER_TIMEOUT_MS).toBeLessThan(3_000);
  });
});
