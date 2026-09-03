/**
 * `POST /api/emit/stream` — kanál s průběhem.
 *
 * Nosná aserce je **shoda verdiktu s `/api/emit`**, ne to, že nějaké rámce
 * dorazily. Dvě cesty ke stejnému řetězu se rozejdou tiše: streamovaná verze
 * začne vracet o pole míň, viewer podle toho postaví scénu a nikdo se nedozví,
 * že se to liší od toho, co změřil offline běh.
 *
 * Druhá půlka souboru soudí **pád uvnitř proudu**, a je to jiná třída tvrzení:
 * tam se neměří, co dorazilo, ale že vůbec něco dorazilo. Hlavičky jsou v tu
 * chvíli dávno u klienta, takže mlčící proud vypadá zvenčí jako úspěch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as emit } from '../route';
import { SseDecoder } from '../../../../components/viewer/sse';
import type { EmissionOutcome, EmitPhase } from '../chain';
import { POST as stream } from '../stream/route';

type Route = (request: Request) => Promise<Response>;

interface Collected {
  readonly status: number;
  readonly contentType: string | null;
  readonly phases: string[];
  readonly result: Record<string, unknown> | null;
}

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/api/emit/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function collect(body: unknown, post: Route = stream): Promise<Collected> {
  const response = await post(request(body));
  const contentType = response.headers.get('content-type');
  if (response.body === null) return { status: response.status, contentType, phases: [], result: null };

  const decoder = new SseDecoder();
  const reader = response.body.getReader();
  const text = new TextDecoder();
  const phases: string[] = [];
  let result: Record<string, unknown> | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of decoder.push(text.decode(value, { stream: true }))) {
      if (frame.event === 'progress') phases.push((JSON.parse(frame.data) as { phase: string }).phase);
      if (frame.event === 'result') result = JSON.parse(frame.data) as Record<string, unknown>;
    }
  }

  return { status: response.status, contentType, phases, result };
}

/** Bez `requestId`, který je z definice pokaždé jiný. */
function comparable(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _ignored, ...rest } = body;
  return rest;
}

describe('kanál s průběhem', () => {
  it('ohlásí fáze v pořadí a skončí verdiktem', async () => {
    const collected = await collect({ promptId: 'C01' });

    expect(collected.status).toBe(200);
    expect(collected.contentType).toBe('text/event-stream; charset=utf-8');
    // Fáze jde ohlásit jen ta, která prošla — u odmítnutí je seznam kratší
    // a zbytek říká `rejection.stage` ve verdiktu.
    expect(collected.phases[0]).toBe('requested');
    expect(collected.phases).toContain('emitted');
    expect(collected.phases).toContain('schema');
    expect(collected.result).not.toBeNull();
  });

  it('průběh čísluje kroky od jedné a nepřeskakuje', async () => {
    const response = await stream(request({ promptId: 'C01' }));
    const raw = await new Response(response.body).text();
    const steps = [...raw.matchAll(/"step":(\d+)/g)].map((match) => Number(match[1]));
    expect(steps).toEqual(steps.map((_, index) => index + 1));
  });

  it('verdikt je tentýž objekt, jaký vrací /api/emit', async () => {
    // Celá zmrazená create sada, ne jeden reprezentativní prompt: rozejít se
    // umí zrovna ta větev, kterou vzorek nepokryje.
    for (const promptId of ['C01', 'C05', 'C08', 'C12', 'C14']) {
      const streamed = await collect({ promptId });
      const direct = await emit(
        new Request('http://127.0.0.1/api/emit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ promptId }),
        }),
      );

      expect(comparable(streamed.result!), promptId).toEqual(
        comparable((await direct.json()) as Record<string, unknown>),
      );
    }
  });

  it('rámce odcházejí průběžně, ne naráz na konci', async () => {
    // Bez tohohle je kanál jen na oko: řetěz je synchronní, takže by se všechny
    // rámce zařadily do fronty v jednom průchodu smyčkou událostí a průběh by
    // dorazil naráz s verdiktem. Neměří se čas, ale **kolikrát se smyčka
    // událostí protočila**, než proud skončil — to je vlastnost, ne rychlost
    // stroje.
    const response = await stream(request({ promptId: 'C01' }));
    const reader = response.body!.getReader();

    let finished = false;
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          finished = true;
          return;
        }
      }
    })();

    let turns = 0;
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      turns += 1;
    }
    await pump;

    // Fází je sedm včetně `requested`. Když se proud odbaví jedním průchodem,
    // napočítá se jeden nebo dva.
    expect(turns).toBeGreaterThan(3);
  });

  it('neznámý prompt jde jako verdikt, ne jako pád', async () => {
    const collected = await collect({ promptId: 'takovy-neni' });
    expect((collected.result as { error: { code: string } }).error.code).toBe('UNKNOWN_PROMPT');
  });

  it('nevalidní tělo odpoví 400 a vůbec nestreamuje', async () => {
    const response = await stream(request({ nope: 1 }));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

/**
 * Načte routu s řetězem, který jde **za běhu rozbít** — a než se rozbije, je
 * to ten skutečný řetěz.
 *
 * ⚠ **Ta přepínatelnost je celé jádro téhle sady, ne pohodlí.** Do 2. 9. 2026
 * se zrušení proudu zkoušelo výhradně nad podvrženým pádem, takže výjimka,
 * kterou `catch` v routě dostal, byla vždycky ten podvrh — **nikdy**
 * `TypeError` z `enqueue`, který v provozu vyrobí odchod klienta. Sada tím
 * certifikovala zařazení, které je špatně, a pět zabitých mutantů z pěti to
 * nechytilo: mutační kontrola měří, jestli aserce nejsou ozdobné, ne jestli
 * fixtura vyrábí ten svět, který vyrobí provoz. **Zrušení se proto od téhle
 * revize zkouší nad zdravým řetězem** a `breakChain()` se volá jen tam, kde se
 * soudí skutečný pád.
 *
 * Modul se načítá znovu, protože `logRateLimited` si počítadlo drží jako stav
 * modulu: bez `resetModules()` by druhý test v tomhle souboru byl už druhým
 * výskytem téhož klíče, mez by ho zahodila a test by měřil počítadlo místo
 * opravy.
 */
async function loadStream(): Promise<{
  readonly post: Route;
  readonly log: string[];
  readonly breakChain: () => void;
  readonly silenceChain: () => void;
}> {
  vi.resetModules();
  let mode: 'healthy' | 'broken' | 'silent' = 'healthy';
  vi.doMock('../chain', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chain')>();
    let calls = 0;
    return {
      ...actual,
      emissionSteps: function* (promptId: string): Generator<EmitPhase, EmissionOutcome, void> {
        if (mode === 'healthy') return yield* actual.emissionSteps(promptId);
        // Řetěz, který **nevydá jedinou fázi** a rovnou vrátí verdikt. Slouží
        // jedinému účelu: posunout zrušení až na `enqueue` rámce `result`.
        if (mode === 'silent') return { kind: 'unknown-prompt' };
        calls += 1;
        throw new Error(`the chain came apart (${calls})`);
      },
    };
  });

  const log: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    log.push(String(line));
  });

  const { POST } = await import('../stream/route');
  return {
    post: POST,
    log,
    breakChain: () => {
      mode = 'broken';
    },
    silenceChain: () => {
      mode = 'silent';
    },
  };
}

/**
 * Podvrhne řetěz tak, že první krok emise vyhodí — tedy **za** odeslanými
 * hlavičkami a za prvním rámcem `progress`, což je přesně to okno, ve kterém
 * do 1. 9. 2026 nevznikla ani odpověď, ani řádek v logu.
 */
async function loadBrokenStream(): Promise<{ readonly post: Route; readonly log: string[] }> {
  const loaded = await loadStream();
  loaded.breakChain();
  return loaded;
}

/**
 * Klient, který odejde uprostřed emise — `Viewer.tsx` to dělá při každé změně
 * promptu.
 *
 * Zrušit se musí **hned po `POST`**, a je to deterministické: `start()` v tu
 * chvíli čeká na `flush()`, tedy na časovač, a mikroúlohy se vyprázdní dřív než
 * kterýkoli časovač. Řetěz se proto poprvé protočí až po tomhle zrušení.
 */
async function leaveMidStream(post: Route, promptId: string): Promise<void> {
  const response = await post(request({ promptId }));
  await response.body!.cancel();
  // A pak nechat `start()` doběhnout až do výjimky.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('pád uvnitř proudu', () => {
  afterEach(() => {
    vi.doUnmock('../chain');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('skončí rámcem result, který se dá spárovat s řádkem operátora', async () => {
    const { post, log } = await loadBrokenStream();
    const collected = await collect({ promptId: 'C01' }, post);

    // Zvenčí to pořád vypadá jako úspěch, a to je celý ten problém: 200,
    // hlavičky proudu, první rámec průběhu. Nosné je, co přijde po nich.
    expect(collected.status).toBe(200);
    expect(collected.phases).toEqual(['requested']);

    const result = collected.result as { requestId: string; error: { code: string; message: string } };
    expect(result.error.code).toBe('STREAM_FAILED');
    // Text výjimky je diagnostika serveru a ven nepatří — táž doktrína jako
    // u `PUBLIC_CORPUS_FAULT`.
    expect(result.error.message).not.toContain('the chain came apart');
    expect(typeof result.requestId).toBe('string');

    // A druhá půlka téhož: operátor dostane přesně jeden řádek, nese text
    // výjimky a **totéž `requestId`**, takže podpora má co dohledat.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('STREAM_FAILED');
    expect(log[0]).toContain('the chain came apart (1)');
    expect(log[0]).toContain(result.requestId);
  });

  it('napíše operátorovi i tehdy, když klient proud zruší — a jmenuje to zrušením', async () => {
    // Tohle je ten případ, kvůli kterému je zápis **před** `enqueue`: na
    // zrušeném proudu `enqueue` vyhodí, takže řádek psaný za ním by nevznikl
    // právě u požadavku, o kterém se operátor potřebuje dozvědět.
    //
    // **Řetěz je tady zdravý, a to je nosné.** Jediná výjimka, která v tomhle
    // testu může vzniknout, je `TypeError: Invalid state: Controller is already
    // closed` ze samotného `enqueue` — tedy přesně ta hodnota, kterou vyrobí
    // odchod klienta v provozu. Nad podvrženým pádem tenhle test měřil roky
    // něco jiného, než si myslel.
    const { post, log } = await loadStream();
    await leaveMidStream(post, 'C01');

    expect(log).toHaveLength(1);
    // A jmenuje to **zrušením**, ne pádem: odchod klienta není porucha.
    expect(log[0]).toContain('STREAM_CANCELLED');
    expect(log[0]).not.toContain('STREAM_FAILED');
  });

  it('pád řetězu PO zrušení je pád, ne zrušení', async () => {
    // ⛔ **Druhý blokující nález revize z 1. 9. 2026, kolo 2.** Oprava kola 1
    // soudila podle stavu proudu (`cancelled ? … : …`), a stav proudu říká,
    // **co se stalo proudu** — ne **co vyhodilo**. V tomhle okně se ty dvě věci
    // rozcházejí: klient odejde, a teprve pak spadne řetěz. Nálepka „zrušení"
    // by ten pád schovala, a protože každé obyčejné proklikání týž klíč
    // posouvá, po pár kliknutích by se zahodil úplně.
    //
    // Zrušení dorazí, dokud `start()` čeká na první `flush()`; řetěz vyhodí až
    // na `steps.next()` hned za ním, tedy dřív, než se dojde k jakémukoli
    // `enqueue`. Výjimka proto **není** `TypeError` z proudu a nálepka to musí
    // poznat.
    const { post, log, breakChain } = await loadStream();
    breakChain();
    await leaveMidStream(post, 'C01');

    expect(log).toHaveLength(1);
    expect(log[0]).toContain('STREAM_FAILED');
    expect(log[0]).not.toContain('STREAM_CANCELLED');
    expect(log[0]).toContain('the chain came apart (1)');
  });

  it('zrušení, které potká až rámec verdiktu, je pořád zrušení', async () => {
    // **Tenhle test hlídá rozsah opravy, ne její princip.** Návrh revize zněl
    // „sentinel ze `send()`", jenže zápisů rámců je v `start()` pět a `send()`
    // je jeden z nich. Zrušení, které dorazí během **posledního** `flush()`,
    // nepotká žádný `progress` — potká `enqueue` rámce `result`. S obalem jen
    // kolem `send()` by z toho byl `STREAM_FAILED`, tedy týž falešný poplach
    // o kus vedle.
    //
    // Řetěz proto nevydá jedinou fázi: `start()` pošle `requested`, zaparkuje
    // na prvním `flush()` — a to je přesně okno, ve kterém zrušení dorazí.
    // Další zápis v pořadí je už verdikt.
    const { post, log, silenceChain } = await loadStream();
    silenceChain();
    await leaveMidStream(post, 'C01');

    expect(log).toHaveLength(1);
    expect(log[0]).toContain('STREAM_CANCELLED');
    expect(log[0]).not.toContain('STREAM_FAILED');
  });

  it('odchod klienta nespotřebuje výskyt, na kterém by se ohlásil skutečný pád', async () => {
    // **Nález nezávislé revize, `VERDICT: blocking`.** `logRateLimited` vydá 1.,
    // 10. a 100. výskyt klíče, takže se sdíleným kódem by první odchod klienta
    // spotřeboval výskyt číslo jedna a pád hned po něm by byl druhý — tedy
    // žádný řádek. A odchod klienta je běžný provoz: `Viewer.tsx` volá `abort()`
    // při každé změně promptu i při odchodu ze stránky.
    const { post, log, breakChain } = await loadStream();

    // Nejdřív obyčejné proklikání nad **zdravým** řetězem: klient odejde
    // uprostřed emise a výjimku vyrobí `enqueue`, jako v provozu.
    await leaveMidStream(post, 'C01');
    // A teprve pak skutečný pád řetězu, který se ohlásit musí.
    breakChain();
    await collect({ promptId: 'C05' }, post);

    expect(log).toHaveLength(2);
    expect(log[0]).toContain('STREAM_CANCELLED');
    expect(log[1]).toContain('STREAM_FAILED');
    // Oba jsou první svého druhu — pád nezdědil rozpočet po zrušení.
    expect(log[1]).toContain('occurrence 1');
  });

  it('dva různé pády v jednom procesu dají dva řádky, ne jeden', async () => {
    // `logRateLimited` klíčuje `(dveře, kód)` a **lepivou** mez tady mít nesmí:
    // `detail` je text výjimky, tedy hodnota bez uzavřeného oboru, a lepivá
    // množina by z paměti udělala funkci počtu cest v kódu. Ta volba platí.
    //
    // **Co se 1. 9. 2026 změnilo, je počet řádků, který z ní plyne.** Do té doby
    // se druhý pád ztratil pod počítadlem prvního; od té doby `logRateLimited`
    // vydá první výskyt každé **nové příčiny** v okně, nejvýš
    // `MAX_DETAILS_PER_WINDOW` na okno (`src/server/public-faults.ts`). Strop je
    // pořád konstanta, jen o řád vyšší než jedna — a dva různé pády jsou dvě
    // různé poruchy, o kterých operátor potřebuje vědět obě.
    //
    // Že se **opakování téže příčiny** pořád nevydá, se soudí v
    // `src/server/__tests__/public-faults.test.ts`: tahle fixtura to ukázat
    // nemůže, protože každý pád očísluje vlastním textem.
    const { post, log } = await loadBrokenStream();
    await collect({ promptId: 'C01' }, post);
    await collect({ promptId: 'C05' }, post);

    expect(log).toHaveLength(2);
    expect(log[0]).toContain('occurrence 1');
    expect(log[0]).toContain('the chain came apart (1)');
    expect(log[1]).toContain('the chain came apart (2)');
  });
});
