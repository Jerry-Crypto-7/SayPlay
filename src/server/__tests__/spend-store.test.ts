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
import { processSpendCap, resetProcessSpendCap } from '../spend-cap';

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
    // Strop procesu si knihu drží taky, a `vi.stubEnv` bez úklidu by ji
    // podstrčil dalšímu testu i s cizím prostředím.
    resetProcessSpendCap();
    vi.unstubAllEnvs();
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

  // ⚠ **Tahle aserce se 4. 9. 2026 OBRÁTILA a byla přepsána, ne smazána**
  // (P15 `T29-lambdadetect`). Do té chvíle stačilo, že `VERCEL` nesvítí — a to
  // je přesně signál, který vercelský přepínač *Automatically expose System
  // Environment Variables* zhasíná spolu s `VERCEL_ENV`. Nasazení s vypnutým
  // přepínačem tak bylo od lokálního běhu nerozeznatelné a dostávalo knihu
  // v paměti, tedy strop krát počet instancí.
  it('známé prostředí mimo serverless dá knihu procesu, poctivě označenou', () => {
    expect(ledgerFromEnv({ VERCEL_ENV: 'production' })?.id).toBe('process-memory');
    expect(ledgerFromEnv({ VERCEL_ENV: 'preview' })?.id).toBe('process-memory');
  });

  /**
   * **Neznámé prostředí je taky zavřené selhání** (P15 `T29-lambdadetect`).
   *
   * „Jeden proces" se musí doložit, ne mlčet: mlčení je stav, ve kterém vypadá
   * nasazení s vypnutým přepínačem stejně jako `next start` na notebooku.
   * Cena je zapsaná v `.env.example` i v hlavičce `ledgerFromEnv()` — lokální
   * běh bez `VERCEL_ENV` placená volání odmítne.
   */
  it('bez známého prostředí a bez úložiště nevydá žádnou knihu', () => {
    expect(ledgerFromEnv({}), 'prázdné prostředí prošlo jako lokální běh').toBeNull();
    // Vlastní vercelské prostředí je nasazení, které se jen jmenuje jinak —
    // a `VERCEL` u něj svítit nemusí, protože ho zhasíná týž přepínač.
    expect(ledgerFromEnv({ VERCEL_ENV: 'staging' })).toBeNull();
    expect(ledgerFromEnv({ VERCEL_ENV: 'qa' })).toBeNull();
    // Prázdná a bílá hodnota je „nenastaveno", ne známé prostředí.
    expect(ledgerFromEnv({ VERCEL_ENV: '  ' })).toBeNull();
  });

  /**
   * Ta přesná dvojice, kterou naměřila revize: přepínač systémových proměnných
   * vypnutý (tedy `VERCEL` i `VERCEL_ENV` zhasnuté) a sdílená kniha nevyplněná.
   * Do 4. 9. 2026 z toho vyšla kniha v paměti procesu.
   */
  it('vypnutý přepínač systémových proměnných nedostane knihu v paměti', () => {
    expect(
      ledgerFromEnv({ WORLDSMITH_SPEND_CAP_USD: '5', WORLDSMITH_BRANCH: 'live' }),
      'nasazení bez systémových proměnných dostalo strop, který se resetuje se studeným startem',
    ).toBeNull();
  });

  it('velikost písmen ani mezery kolem známého prostředí nerozhodují', () => {
    expect(ledgerFromEnv({ VERCEL_ENV: ' Production ' })?.id).toBe('process-memory');
  });

  /**
   * **Tatáž brána, ale tvarem, kterým ji volá produkce** — nález nezávislé
   * revize 4. 9. 2026 (LOW) k `T29-lambdadetect`.
   *
   * Všechny aserce výš předávají `ledgerFromEnv()` vlastní objekt prostředí,
   * takže se `process.env` cesty nedotknou. Jenže právě tu bere
   * `processSpendCap()` (`spend-cap.ts`), a to je jediný strop, kterým placené
   * routy doopravdy chodí. Regrese v tom napojení — kdyby `spendCapFromEnv()`
   * přestala knihu z prostředí brát, nebo kdyby `null` přestalo znamenat
   * odmítnutí — by celou sadu nechala zelenou.
   *
   * ⚠ **Proto se tady `VERCEL_ENV` odstraňuje ručně:** `vitest.config.mts` ho
   * pro celý běh nastavuje na `production`, což je nutné, aby ostatní testy
   * měřily svůj předmět. Tenhle jediný ho musí zase sundat, jinak by měřil
   * konfiguraci sady, ne bránu.
   */
  it('strop procesu odmítne rezervaci, když prostředí v `process.env` chybí', async () => {
    resetProcessSpendCap();
    vi.stubEnv('VERCEL_ENV', '');

    const refused = await processSpendCap().reserve(0.01);
    expect(refused.ok, 'strop pustil placené volání bez knihy, která by ho udržela').toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('STORE_UNCONFIGURED');

    // Překlep operátora je „neznámo", ne produkce — `prod` na uzavřeném seznamu
    // není a nesmí se na něj dostat žádnou tolerancí.
    resetProcessSpendCap();
    vi.stubEnv('VERCEL_ENV', 'prod');
    expect((await processSpendCap().reserve(0.01)).ok, '`prod` prošlo jako známé prostředí').toBe(
      false,
    );

    // A z druhé strany: se známým prostředím tatáž rezervace projde, takže se
    // netvrdí jen „něco odmítá".
    resetProcessSpendCap();
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await processSpendCap().reserve(0.01)).ok).toBe(true);
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
    // Známé prostředí `VERCEL` nepřebíjí — na Vercelu je produkce pořád N
    // procesů, takže kniha v paměti by tam držela přesně nic.
    expect(ledgerFromEnv({ VERCEL: '1', VERCEL_ENV: 'production' })).toBeNull();
    expect(ledgerFromEnv({ VERCEL: '', VERCEL_ENV: 'preview' })).toBeNull();
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
    // ⚠ **Očekávaný klíč se od `T29-explicitscope` změnil a byl přepsán, ne
    // smazán.** Výslovná předpona je nově ZÁKLAD jména, ne celé jméno, takže
    // se k ní segment prostředí připojí stejně jako k odvozené — tady
    // `unknown-env`, protože `STORE_ENV` sdílenou knihu má a `VERCEL_ENV`
    // nenese. Vlastnost, kterou test pinuje (předpona se propíše až do klíče,
    // kam se doopravdy zapisuje), platí dál.
    const fetchImpl = vi.fn<typeof fetch>(async () => pipelineAnswer(0, 0));
    await ledgerFromEnv({ ...STORE_ENV, WORLDSMITH_SPEND_STORE_PREFIX: 'demo' }, fetchImpl)?.add(1, 1);

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))[0][1]).toBe('demo:unknown-env:usd');
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
    // Mimo Vercel a BEZ sdílené knihy je jediný proces norma, tam holý základ
    // platí dál. Tohle tvrzení `T29-unknownenv` **nepřevrátila** — jen ho
    // zúžila o sdílenou knihu, viz případ níž.
    expect(storePrefix({})).toBe('worldsmith:spend');
  });

  it('sdílená kniha bez známého prostředí nedostane produkční klíč, ani když VERCEL zhasne', () => {
    // **Naměřená vada druhé nezávislé revize (4. 9. 2026):** záchranná síť na
    // chybějící `VERCEL_ENV` visela na `VERCEL`, jenže vercelský přepínač
    // *Automatically expose System Environment Variables* zhasíná obě proměnné
    // naráz. V tom jediném případě, kvůli kterému síť existuje, tedy nebyla —
    // a nasazení dostalo `worldsmith:spend`, tedy produkční rozpočet.
    //
    // Rozhoduje proto sdílená kniha, ne platforma: adresa a token jsou
    // uživatelské proměnné a ten přepínač je nevypíná.
    expect(storePrefix({ ...STORE_ENV })).toBe('worldsmith:spend:unknown-env');
    expect(storePrefix({ ...STORE_ENV, VERCEL_ENV: '  ' })).toBe('worldsmith:spend:unknown-env');
    expect(storePrefix({ ...STORE_ENV, VERCEL_ENV: 'staging' })).toBe(
      'worldsmith:spend:unknown-env',
    );

    // Známé prostředí rozhoduje pořád samo — sdílená kniha ho nepřebíjí, jinak
    // by se produkční kniha přejmenovala pod běžícím nasazením.
    expect(storePrefix({ ...STORE_ENV, VERCEL_ENV: 'production' })).toBe('worldsmith:spend');
    expect(storePrefix({ ...STORE_ENV, VERCEL_ENV: 'preview' })).toBe('worldsmith:spend:preview');
  });

  /**
   * **Vlastní prostředí je nasazení, i když o sobě nic jiného neřekne** — a je
   * to jediné místo, kde se „`VERCEL_ENV` chybí" a „`VERCEL_ENV` je cizí slovo"
   * chovají různě.
   *
   * Holý základ smí dostat jen ticho: běh, o kterém nic netvrdí, že je
   * nasazení, a do jehož knihy nikdo další nepíše. `staging` je proti tomu
   * povel — někdo to prostředí založil, a Vercel to dovoluje. Přiřknout mu
   * produkční klíč znamená dát mu produkční rozpočet, což je táž vada jako
   * dřívější rozpočet na větev.
   *
   * ⚠ **Přeživší mutant P15 `T29-lambdadetect`.** Do téhle aserce ten rozdíl
   * nehlídalo nic: sloučení obou případů do jednoho nechalo sadu (4068) zelenou.
   */
  it('vlastní prostředí bez sdílené knihy taky nedostane holý základ', () => {
    expect(storePrefix({ VERCEL_ENV: 'staging' })).toBe('worldsmith:spend:unknown-env');
    expect(storePrefix({ VERCEL_ENV: 'qa' })).toBe('worldsmith:spend:unknown-env');
    // A naopak: ticho holý základ dostane dál, jinak by se lokálnímu běhu
    // přejmenovala kniha bez důvodu.
    expect(storePrefix({})).toBe('worldsmith:spend');
    expect(storePrefix({ VERCEL_ENV: '  ' })).toBe('worldsmith:spend');

    // **Půlka konfigurace není konfigurace.** Adresa bez tokenu knihu nesdílí
    // (`ledgerFromEnv` z ní také žádnou neudělá), takže přejmenovat lokální
    // knihu by tu znamenalo zahodit dosud naúčtovanou útratu za nic.
    expect(storePrefix({ WORLDSMITH_SPEND_STORE_URL: STORE_ENV.WORLDSMITH_SPEND_STORE_URL })).toBe(
      'worldsmith:spend',
    );
    expect(
      storePrefix({ WORLDSMITH_SPEND_STORE_TOKEN: 'token', WORLDSMITH_SPEND_STORE_URL: '   ' }),
    ).toBe('worldsmith:spend');
  });

  it('klíč a úložiště se nesmí rozejít: co je sdílená kniha pro předponu, je jí i pro zápis', () => {
    // Dvě definice „sdílené knihy" by znamenaly klíč, který mluví o jiném
    // uložišti, než kam zápis míří. Porovnává se proto odpověď obou funkcí, ne
    // jejich vnitřek.
    //
    // ⚠ **Rovnost „neznámý klíč ⇔ sdílená kniha" má TŘI výjimky a ty se
    // vyjmenovávají, ne vynechávají z matice** — nález nezávislé revize
    // 4. 9. 2026. Zelená, které se dosáhne kurátorováním seznamu vstupů, tvrdí
    // pravidlo, jaké kód nemá: dopsání `{VERCEL:'1'}` by ji rozsvítilo červeně
    // bez jediné vady. Každá výjimka má tedy vlastní aserci dole.
    const envs: Record<string, string | undefined>[] = [
      {},
      { ...STORE_ENV },
      { ...STORE_ENV, VERCEL: '1' },
      { ...STORE_ENV, VERCEL_ENV: 'staging' },
      { WORLDSMITH_SPEND_STORE_URL: 'https://ledger.example.com/' },
      { WORLDSMITH_SPEND_STORE_TOKEN: 'token' },
      { WORLDSMITH_SPEND_STORE_URL: '  ', WORLDSMITH_SPEND_STORE_TOKEN: '  ' },
      // **Výslovný základ patří do matice, ne jen pod ni** — nález nezávislé
      // revize 4. 9. 2026. Dokud se porovnávalo proti napsanému
      // `'worldsmith:spend:unknown-env'`, nešel sem přidat jediný řádek
      // s předponou, aniž by matice zčervenala bez vady; celá výslovná větev
      // proto stála na dvou ručních asercích dole.
      { ...STORE_ENV, WORLDSMITH_SPEND_STORE_PREFIX: 'demo' },
      // A základ, který segment už nese — přesně tvar, ke kterému operátora
      // svádí migrační odstavec v `.env.example`. Segment se připojí i k němu.
      { ...STORE_ENV, WORLDSMITH_SPEND_STORE_PREFIX: 'demo:preview' },
    ];

    for (const env of envs) {
      const shares = ledgerFromEnv(env)?.id === 'http';
      const base = env.WORLDSMITH_SPEND_STORE_PREFIX?.trim() || 'worldsmith:spend';
      const unknown = storePrefix(env) === `${base}:unknown-env`;
      expect(unknown, `klíč a úložiště se rozešly pro ${JSON.stringify(env)}`).toBe(shares);
    }

    // ⚠ **Tohle byla do 4. 9. 2026 „Výjimka 1" a přestala jí být**
    // (`T29-explicitscope`). Výslovná předpona odvození nevypíná, jen mu mění
    // základ, takže rovnost „neznámý klíč ⇔ sdílená kniha" platí i pro ni —
    // jen se soudí proti `demo:unknown-env` místo proti výchozímu základu.
    // Zůstává tu proto, že to je ten případ, kde se rovnost dřív lámala.
    const explicit = { ...STORE_ENV, WORLDSMITH_SPEND_STORE_PREFIX: 'demo' };
    expect(storePrefix(explicit)).toBe('demo:unknown-env');
    expect(ledgerFromEnv(explicit)?.id).toBe('http');

    // **Výjimka 2 — známé prostředí rozhoduje samo.** Sdílená kniha ho
    // nepřebíjí, jinak by produkce účtovala pod neznámem.
    const production = { ...STORE_ENV, VERCEL_ENV: 'production' };
    expect(storePrefix(production)).toBe('worldsmith:spend');
    expect(ledgerFromEnv(production)?.id).toBe('http');

    // **Výjimka 3 — `VERCEL` bez sdílené knihy.** Prostředí je neznámé
    // nasazení, takže klíč je `unknown-env`, ale zapisovat není kam: kniha je
    // `null`, tedy zavřené selhání. Klíč tu tedy nikam nevede a rozejít se
    // nemá s čím.
    expect(storePrefix({ VERCEL: '1' })).toBe('worldsmith:spend:unknown-env');
    expect(ledgerFromEnv({ VERCEL: '1' })).toBeNull();
  });

  /**
   * **Doktrína zotavení, kterou `.env.example` tvrdí a oko ji neuvidí.**
   *
   * Nález nezávislé revize 4. 9. 2026: migrační odstavec radil dopsat segment
   * rovnou do hodnoty proměnné, což starý klíč nevrátí — vyrobí TŘETÍ, na
   * kterém nikdo nic neutratil, a operátor k uvízlé útratě dostane celý strop
   * navrch. Text se opravil; tenhle test hlídá, že se opravil na pravdu.
   */
  it('mimo produkci nevrátí starý klíč žádná hodnota té proměnné', () => {
    const mimoVercel = { ...STORE_ENV };
    const starý = storePrefix(mimoVercel);
    expect(starý).toBe('worldsmith:spend:unknown-env');

    // Připnutí staré hodnoty: tichý no-op, klíč se nehne.
    expect(storePrefix({ ...mimoVercel, WORLDSMITH_SPEND_STORE_PREFIX: 'worldsmith:spend' })).toBe(starý);
    // Dopsání segmentu: třetí klíč, ne ten původní.
    expect(storePrefix({ ...mimoVercel, WORLDSMITH_SPEND_STORE_PREFIX: starý })).toBe(
      'worldsmith:spend:unknown-env:unknown-env',
    );
    // Táž past na preview.
    const preview = { ...STORE_ENV, VERCEL: '1', VERCEL_ENV: 'preview' };
    expect(storePrefix({ ...preview, WORLDSMITH_SPEND_STORE_PREFIX: 'demo:preview' })).toBe(
      'demo:preview:preview',
    );
    // Jediné prostředí, kde výslovná hodnota klíč doopravdy určí.
    expect(
      storePrefix({ ...STORE_ENV, VERCEL_ENV: 'production', WORLDSMITH_SPEND_STORE_PREFIX: 'worldsmith:spend' }),
    ).toBe('worldsmith:spend');
  });

  it('výslovná předpona mění základ jména, ne pravidla pod ním', () => {
    // ⚠ **Tenhle případ tvrdil do 4. 9. 2026 „výslovná vyhrává nad odvozením"
    // a byl přepsán, ne smazán** (`T29-explicitscope`; mění to napsané AC
    // `T29-storeprefix`). Důvod je naměřený: vercelské UI při zakládání
    // proměnné předškrtává všechna tři prostředí, takže operátor, který se
    // řídil starou radou, tím odvození vypnul a preview začalo účtovat do
    // produkční knihy. „Výslovná vyhrává" je proto pravidlo o tom, KTERÝ
    // základ, ne o tom, jestli se prostředí připojí.
    expect(
      storePrefix({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'x', WORLDSMITH_SPEND_STORE_PREFIX: 'demo' }),
    ).toBe('demo:preview');
    // Produkce si holý základ nechá — i ten výslovný.
    expect(storePrefix({ VERCEL: '1', VERCEL_ENV: 'production', WORLDSMITH_SPEND_STORE_PREFIX: 'demo' })).toBe(
      'demo',
    );
    // A lokální běh bez sdílené knihy taky: není s čím kolidovat.
    expect(storePrefix({ WORLDSMITH_SPEND_STORE_PREFIX: 'demo' })).toBe('demo');
    // Mimo Vercel žádné `VERCEL_ENV` není a kniha se nesmí přejmenovat pod
    // běžícím nasazením — proto tentýž holý základ jako produkce.
    expect(storePrefix({})).toBe('worldsmith:spend');
    // Bílé znaky jsou „nenastaveno", stejně jako u adresy a tokenu výš.
    expect(storePrefix({ VERCEL_ENV: 'preview', WORLDSMITH_SPEND_STORE_PREFIX: '  ' })).toBe(
      'worldsmith:spend:preview',
    );
  });

  it('odvozené klíče jsou právě tři, ať do VERCEL_ENV napíše kdo chce co chce', () => {
    // **Tenhle případ nahradil starší „jméno prostředí se vyčistí".** Ten
    // tvrdil, že `VERCEL_ENV: 'staging:usd nasty/#'` má dát vlastní vyčištěný
    // klíč `worldsmith:spend:staging-usd-nasty--` — čistil tedy tvar hodnoty
    // a mlčel o tom, kolik různých knih ta hodnota umí založit. Druhá nezávislá
    // revize to spustila: `staging`, `qa` a `development` daly tři různé
    // rozpočty, a Vercel dovoluje zakládat vlastní prostředí, takže počet
    // hodnot neomezuje nic — táž vada, jakou u větví zavřel commit e1b2595.
    // Pinuje se proto POČET klíčů, ne jejich pravopis.
    const scopes = ['production', 'preview', 'staging', 'qa', 'development', 'PREVIEW', '  ', ''];
    const keys = new Set(scopes.map((VERCEL_ENV) => storePrefix({ VERCEL: '1', VERCEL_ENV })));

    expect(keys, 'prostředí si vyrobilo vlastní rozpočet').toEqual(
      new Set(['worldsmith:spend', 'worldsmith:spend:preview', 'worldsmith:spend:unknown-env']),
    );
    // Neznámé prostředí je neznámo, ne vlastní kniha — a ne produkce.
    expect(storePrefix({ VERCEL: '1', VERCEL_ENV: 'staging' })).toBe(
      'worldsmith:spend:unknown-env',
    );
    // Velikost písmen knihu nerozdvojuje.
    expect(storePrefix({ VERCEL: '1', VERCEL_ENV: 'Production' })).toBe('worldsmith:spend');
    // Klíč nemůže růst s tím, co kdo do proměnné napíše — délka je daná mapou.
    expect(storePrefix({ VERCEL: '1', VERCEL_ENV: 'a'.repeat(500) })).toBe(
      'worldsmith:spend:unknown-env',
    );
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
