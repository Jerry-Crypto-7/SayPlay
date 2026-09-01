/**
 * Mapování výsledků řetězu na stavové kódy.
 *
 * Kontrakt samotného řetězu (pořadí článků, účtování, obě větve) drží
 * `src/server/__tests__/pipeline.test.ts`. Tady se testuje jen to, co přidává
 * HTTP vrstva — a co by jinak nikdo neověřil, protože rozdíl mezi 404 a 502 se
 * v žádném jiném testu neprojeví.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withoutCredentials } from '../../../../server/public-faults';

import { frozenPrompts } from '../../../../model/client';

const promptsRead = frozenPrompts();
if (!promptsRead.ok) throw new Error(`frozen prompts unreadable: ${promptsRead.detail}`);
const FROZEN_CREATE = promptsRead.value.find((record) => record.kind === 'create');
if (FROZEN_CREATE === undefined) throw new Error('the frozen corpus carries no create prompt');

const temporary: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ResponseBody {
  readonly requestId: string;
  readonly branch?: string;
  readonly emission?: unknown;
  readonly costUsd?: number;
  readonly error?: { readonly code: string; readonly message: string; readonly category?: string };
}

/**
 * Načte routu nad daným prostředím.
 *
 * Strop si routa drží jako stav procesu, takže se modul musí načíst až po
 * prostředí — a **jedno načtení je jedna instance stropu**. Test, který chce
 * ověřit hromadění útraty přes víc požadavků, proto volá `POST` z jednoho
 * načtení opakovaně, ne `post()` dvakrát.
 */
async function loadRoute(env: Record<string, string> = {}) {
  // Každé načtení začíná od čistého prostředí, jinak by druhé v jednom testu
  // zdědilo nastavení prvního a tvrdilo něco jiného, než co se měří.
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { POST } = await import('../route');
  return async (body: string) => {
    const response = await POST(new Request('http://127.0.0.1/api/generate', { method: 'POST', body }));
    return { status: response.status, json: (await response.json()) as ResponseBody };
  };
}

async function post(body: string, env: Record<string, string> = {}) {
  return (await loadRoute(env))(body);
}

function controlFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-route-'));
  temporary.push(dir);
  const path = join(dir, 'spend-cap.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('POST /api/generate', () => {
  it('vydá emisi z offline větve, když prostředí neříká jinak', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    expect(status).toBe(200);
    expect(json.branch).toBe('mock');
    expect(typeof json.emission).toBe('object');
    expect(json.costUsd).toBe(0);
  });

  it('prompt mimo zmrazený korpus je 404, ne chyba serveru', async () => {
    // Poctivé „na tohle odpověď nemám". Fallback z P2 se věší sem, ne dovnitř
    // generování.
    const { status, json } = await post(JSON.stringify({ prompt: 'svět, na který záznam nikdy nebyl' }));
    expect(status).toBe(404);
    expect(json.error?.code).toBe('NO_SOURCE');
  });

  it('odmítnutý prompt je 400, ne 500', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: '   ' }));
    expect(status).toBe(400);
    expect(json.error?.code).toBe('PROMPT_REFUSED');
    expect(json.error?.category).toBe('EMPTY');
  });

  it('chybějící pole prompt je taky odmítnutí, ne pád', async () => {
    const { status, json } = await post(JSON.stringify({}));
    expect(status).toBe(400);
    expect(json.error?.category).toBe('NOT_TEXT');
  });

  it('tělo, které není JSON, je 400', async () => {
    const { status, json } = await post('{ tohle není JSON');
    expect(status).toBe(400);
    expect(json.error?.code).toBe('MALFORMED_BODY');
  });

  it('vyčerpaný rozpočet je 429 a nikam se nevolá', async () => {
    // Koncový bod je nedosažitelná adresa schválně: kdyby strop odmítal až po
    // volání, spadlo by to na DNS a test by prošel z jiného důvodu.
    const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      WORLDSMITH_SPEND_CAP_USD: '0',
    });
    expect(status).toBe(429);
    expect(json.error?.code).toBe('CAP_EXHAUSTED');
  });

  it('odmítnutí stropem neposílá ven čísla ani cestu na disk', async () => {
    // `/api/generate` nechce přihlášení (AC T301), takže „ven" znamená komukoli
    // na internetu. Přesný zbytek rozpočtu umožňuje načasovat zneužití a
    // absolutní cesta prozradí rozvržení souborů serveru včetně jména účtu.
    // Text pro operátora čísla nese dál — ořezává se až tady, viz PUBLIC_REFUSAL.
    const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      WORLDSMITH_SPEND_CAP_USD: '0',
    });

    expect(status).toBe(429);
    expect(json.error?.code).toBe('CAP_EXHAUSTED');
    const message = String(json.error?.message);
    expect(message, 'ven odešlo číslo').not.toMatch(/\d/);
    expect(message, 'ven odešla cesta na disk').not.toMatch(/[\/]/);
  });

  it('rozbitý vypínač neprozradí cestu k ovládacímu souboru', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldsmith-route-'));
    const path = join(dir, 'spend-cap.json');
    writeFileSync(path, 'tohle není JSON', 'utf8');

    try {
      const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_FILE: path,
      });

      expect(status).toBe(503);
      expect(json.error?.code).toBe('CONTROL_UNREADABLE');
      expect(String(json.error?.message), 'ven odešla cesta k souboru').not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('vyčerpaný počet volání je taky 429, i když dolary zbývají', async () => {
    // Druhá pojistka vedle dolarové: ta stojí na ceníku opsaném ručně, takže
    // překlep o tři řády ji roztáhne milionkrát. Rozpočet je tu schválně
    // obrovský — odmítnout musí počítadlo, ne peníze.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({ content: [{ type: 'text', text: '{"emitted":true}' }], usage: { input_tokens: 10, output_tokens: 10 } }),
      ),
    );

    const call = await loadRoute({
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      WORLDSMITH_SPEND_CAP_USD: '1000',
      WORLDSMITH_CALL_CAP: '1',
    });

    expect((await call(JSON.stringify({ prompt: 'bludiště s klíčem' }))).status).toBe(200);

    const second = await call(JSON.stringify({ prompt: 'bludiště s klíčem' }));
    expect(second.status).toBe(429);
    expect(second.json.error?.code).toBe('CALL_CAP_EXHAUSTED');
  });

  it('útrata se sčítá přes požadavky — strop je stav procesu, ne požadavku', async () => {
    // Strop, který se rodí s každým požadavkem, je dekorace: první volání by ho
    // nikdy nevyčerpalo a další by o něm nevědělo. Rozpočet je proto nastavený
    // přesně na jedno volání.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({ content: [{ type: 'text', text: '{"emitted":true}' }], usage: { input_tokens: 100, output_tokens: 200 } }),
      ),
    );

    const call = await loadRoute({
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      // Výslovná nula, protože připíchnutých 0,12 USD níž má znamenat PŘESNĚ
      // jeden nejhorší případ. Nevyplněná cena vstupu se od 21. 8. 2026
      // dopočítá z ceny výstupu (dřív byla nula), takže bez tohohle řádku by
      // rezervace zahrnula i ~3000 vstupních tokenů a odmítla už první volání.
      WORLDSMITH_USD_PER_MTOK_IN: '0',
      WORLDSMITH_MAX_OUTPUT_TOKENS: '8000',
      // 8000 tokenů × 15 USD/Mtok = 0,12 USD, tedy přesně jeden nejhorší případ.
      WORLDSMITH_SPEND_CAP_USD: '0.12',
    });

    const first = await call(JSON.stringify({ prompt: 'bludiště s klíčem' }));
    expect(first.status).toBe(200);

    const second = await call(JSON.stringify({ prompt: 'bludiště s klíčem' }));
    expect(second.status).toBe(429);
    expect(second.json.error?.code).toBe('CAP_EXHAUSTED');
  });

  it('rozbitý vypínač je 503, ne tichý průchod bez stropu', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }), {
      WORLDSMITH_SPEND_CAP_FILE: controlFile('{ rozbito'),
    });
    expect(status).toBe(503);
    expect(json.error?.code).toBe('CONTROL_UNREADABLE');
  });

  it('živá větev bez konfigurace je 503, a offline větev tím netrpí', async () => {
    const unconfigured = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }), {
      WORLDSMITH_BRANCH: 'live',
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.json.error?.code).toBe('BRANCH_UNCONFIGURED');

    const offline = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    expect(offline.status).toBe(200);
  });

  it('každá odpověď nese korelační ID', async () => {
    const ok = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    const bad = await post(JSON.stringify({ prompt: '' }));
    expect(typeof ok.json.requestId).toBe('string');
    expect(typeof bad.json.requestId).toBe('string');
    expect(ok.json.requestId).not.toBe(bad.json.requestId);
  });

  /**
   * Adresa v odpovědi vypadá jako poctivá diagnostika a čte se úplně stejně
   * dobře jako věta bez ní — proto se to soudí strojově, ne okem. Spouštěč je
   * dosažitelný **bez útočníka**: adresa bez schématu je běžný překlep při
   * kopírování z `.env.example` a `fetch` z ní složí
   * `Failed to parse URL from <celá adresa včetně query>`.
   */
  it('selhání generování neposílá ven nakonfigurovanou adresu', async () => {
    const endpoint = 'upstream.invalid/v1/messages?tenant=acme-worldsmith';
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: endpoint,
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
    });

    expect(status).toBe(502);
    expect(json.error?.code).toBe('UPSTREAM_UNAVAILABLE');

    const message = String(json.error?.message);
    expect(message).not.toContain(endpoint);
    // Ne jen celá adresa: kterýkoli devítiznakový kus z ní stačí, aby se
    // hostitel nebo tenant dal poskládat zpátky.
    for (let at = 0; at + 9 <= endpoint.length; at += 1)
      expect(message, `ven odešel kus adresy „${endpoint.slice(at, at + 9)}"`).not.toContain(
        endpoint.slice(at, at + 9),
      );

    // Druhá půlka téhož: ořezat ven se smí jen tak, aby to operátor pořád
    // našel. Kanál je stderr procesu, který vidí jen ten, kdo server provozuje.
    expect(logged.join('\n')).toContain(endpoint);
    expect(logged.join('\n')).toContain(String(json.requestId));
  });

  it('ani operátorův log nenese heslo z adresy', async () => {
    // „Operátorův stderr" je na cílové platformě runtime log viditelný celému
    // projektu a všem odtokům — nález nezávislé revize 31. 8. 2026. Adresa se
    // do něj píše dál, protože bez ní ten řádek nic nediagnostikuje; heslo ne.
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'operator:hunter2@upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
    });

    expect(logged.join('\n'), 'do logu odešlo heslo').not.toContain('hunter2');

    // Že hostitel v logu naopak **zůstat má**, drží test nad adresou bez
    // schématu výš. Tady ho `fetch` do hlášky nedá vůbec (vrací holé „fetch
    // failed"), takže by se tu nedalo měřit — naměřeno, ne odhadnuto.
    expect(withoutCredentials('at https://operator:hunter2@upstream.invalid/v1')).toBe(
      'at https://<credentials>@upstream.invalid/v1',
    );
  });

  /**
   * Druhý vchod k téže kořisti, a proto vlastní tvrzení.
   *
   * `readFrozen()` skládá detail jako „<soubor> is not readable under <cesta>",
   * kde ta cesta je **absolutní, včetně jména účtu** — přesně to, co si test
   * o vypínači stropu výš zakazuje posílat ven. Spustit ten stav za běhu by
   * znamenalo rozbít `evals/frozen/` na disku, což je zmrazená sada a nesahá
   * se na ni, takže se to soudí **nad zdrojem**: v routě nesmí zůstat místo,
   * kde `grammar.detail` teče do odpovědi.
   */
  it('detail od zmrazeného korpusu nikam do odpovědi neteče', () => {
    const source = readFileSync(new URL('../route.ts', import.meta.url), 'utf8');
    const uses = source.match(/grammar\.detail/g) ?? [];

    expect(uses).toHaveLength(1);
    expect(source).toContain('logForOperator(requestId, grammar.reason, grammar.detail)');
    expect(source).toContain('PUBLIC_CORPUS_FAULT[grammar.reason]');
  });

  /**
   * **Čtyři nálezy nezávislé revize 31. 8. 2026, uzavřené 1. 9. 2026.** Všechny
   * čtyři vypadají v jednotkovém běhu zeleně a projeví se až na nasazeném
   * serveru — proto mají vlastní pin, a proto se každý soudí nad tím, co
   * doopravdy odešlo (odpověď, nebo řádek na stderr), ne nad zdrojem.
   */
  describe('co jde ven a co jde operátorovi', () => {
    /** Odchytí stderr routy. Vrací pole řádků, do kterého route zapisuje. */
    function captureOperatorLog(): string[] {
      const logged: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        logged.push(String(line));
      });
      return logged;
    }

    /**
     * `NO_SOURCE` je u offline větve **normální odpověď**, ne porucha: porotce
     * má právo zkoušet vlastní věty (`RULES.md` §3.3) a každá mimo zmrazený
     * korpus sem dojde. Kdyby se logovala, zaplnila by nejběžnější odpověď dema
     * operátorův log a skutečné `UPSTREAM_*` by se v něm ztratilo přesně ve
     * chvíli, kdy je někdo hledá.
     */
    it('prompt mimo korpus nezapíše operátorovi nic, na rozdíl od skutečné poruchy', async () => {
      const logged = captureOperatorLog();

      const missing = await post(JSON.stringify({ prompt: 'svět, na který záznam nikdy nebyl' }));
      expect(missing.status).toBe(404);
      expect(logged, 'běžná odpověď 404 zapsala operátorovi řádek').toEqual([]);

      // Druhá půlka téhož tvrzení: ticho nesmí být proto, že se neloguje nic.
      const broken = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
      });
      expect(broken.status).toBe(502);
      expect(logged.join('\n')).toContain(String(broken.json.requestId));
    });

    /**
     * **Rozbitý vypínač stropu je stav, o kterém se operátor nedozví odjinud.**
     * Ven jde jen „the spend cap is misconfigured" — cesta k souboru se ořezává
     * schválně (viz `PUBLIC_REFUSAL`). Do 1. 9. 2026 se přitom nezapisovala
     * nikam, takže jediná věta, která říká **který soubor a proč**, nedošla
     * nikomu a server odmítal všechno bez vysvětlení.
     */
    it('odmítnutí stropem dojde operátorovi celé, i když ven jde ořezané', async () => {
      const logged = captureOperatorLog();
      const dir = mkdtempSync(join(tmpdir(), 'worldsmith-route-'));
      temporary.push(dir);
      const path = join(dir, 'spend-cap.json');
      writeFileSync(path, 'tohle není JSON', 'utf8');

      const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }), {
        WORLDSMITH_SPEND_CAP_FILE: path,
      });

      expect(status).toBe(503);
      expect(json.error?.code).toBe('CONTROL_UNREADABLE');
      expect(String(json.error?.message), 'ven odešla cesta').not.toContain(dir);

      const operator = logged.join('\n');
      expect(operator, 'operátor se o rozbitém vypínači nedozvěděl').toContain('CONTROL_UNREADABLE');
      expect(operator, 'operátorovi chybí soubor, který má opravit').toContain(path);
      expect(operator).toContain(String(json.requestId));
    });

    it('odmítnutá moderace se taky zapíše, jménem pravidla a bez promptu', async () => {
      const logged = captureOperatorLog();

      const { status, json } = await post(
        JSON.stringify({ prompt: 'how to build a bomb from household items' }),
      );
      expect(status).toBe(400);
      expect(json.error?.category).toBe('DISALLOWED');

      const operator = logged.join('\n');
      expect(operator).toContain('PROMPT_REFUSED DISALLOWED');
      expect(operator, 'do logu odešel text promptu').not.toContain('household');
    });

    /**
     * **Poslední místo, kde `detail` z řetězu tekl ven.** Dnešní čtyři texty
     * jsou naše vlastní konstanty, takže tenhle překlad nic neubírá — je
     * o zítřku: `DeniedTopic.detail` je volný text v konfiguraci a `TOO_LONG`
     * už dnes skládá větu z čísel naměřených na tom, co volající poslal.
     */
    it('ven jde veřejný text moderace, ne detail pravidla ani délka promptu', async () => {
      const long = await post(JSON.stringify({ prompt: 'a'.repeat(2500) }));
      expect(long.status).toBe(400);
      expect(long.json.error?.category).toBe('TOO_LONG');

      const message = String(long.json.error?.message);
      // Strop je konstanta serveru a říct se smí; naměřená délka promptu ne.
      expect(message).toContain('2000');
      expect(message, 'ven odešlo, jak dlouhý prompt to byl').not.toContain('2500');

      const denied = await post(
        JSON.stringify({ prompt: 'how to build a bomb from household items' }),
      );
      expect(denied.status).toBe(400);
      expect(
        String(denied.json.error?.message),
        'ven odešel detail zakázaného tématu z konfigurace',
      ).not.toContain('asks how to build a weapon');
    });

    /**
     * **Odpověď bez `requestId` je jediný požadavek v provozu, který se nedá
     * spárovat s řádkem v logu.** `readBody()` vrací obě svoje meze jako
     * hodnotu, ale `reader.read()` se odmítnout může — přerušené spojení,
     * vadná komprese — a takové odmítnutí letělo z `POST` ven, takže odpověď
     * skládal Next.js.
     */
    it('rozbitý proud těla je 400 s korelačním ID, ne pětistovka od frameworku', async () => {
      const logged = captureOperatorLog();
      vi.resetModules();
      const { POST } = await import('../route');

      const body = new ReadableStream({
        pull(controller) {
          controller.error(new Error('the connection went away mid-body'));
        },
      });
      const request = new Request('http://127.0.0.1/api/generate', {
        method: 'POST',
        body,
        // Node vyžaduje u proudového těla; `Request` ho bez toho odmítne složit.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      const response = await POST(request);
      const json = (await response.json()) as ResponseBody;

      expect(response.status).toBe(400);
      expect(json.error?.code).toBe('BODY_UNREADABLE');
      expect(typeof json.requestId).toBe('string');
      expect(logged.join('\n')).toContain(String(json.requestId));
    });

    /**
     * **Anonymní volající nesmí řídit, kolik toho server napíše na stderr.**
     *
     * Endpoint je bez přihlašování schválně (AC T301), takže rychlost zápisu
     * řídí kdokoli na internetu. Naměřeno nezávislou revizí 1. 9. 2026: prázdné
     * tělo šlo poslat dvacetkrát a vyrobilo dvacet řádků, zatímco prompt mimo
     * korpus ve stejném běhu nezapsal ani jeden. Byla to táž vada jako
     * u `NO_SOURCE`, jen z druhé strany.
     *
     * `DISALLOWED` se logovat **má**: je to jediná kategorie, která znamená, že
     * někdo zkouší, kam až smí. Zbylé tři popisuje odpověď celé.
     */
    it('vady dotazu operátorovi nepíšou nic, ať jich přijde kolik chce', async () => {
      const logged = captureOperatorLog();
      const call = await loadRoute();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect((await call(JSON.stringify({}))).status).toBe(400);
        expect((await call(JSON.stringify({ prompt: '   ' }))).status).toBe(400);
      }
      expect(logged, 'prázdné tělo dokáže psát operátorovi na stderr').toEqual([]);

      // A ticho zase nesmí být proto, že se z moderace neloguje nic.
      expect((await call(JSON.stringify({ prompt: 'how to build a bomb' }))).status).toBe(400);
      expect(logged.join('\n')).toContain('PROMPT_REFUSED DISALLOWED');
    });

    /**
     * **Odmítnutí stropem je lepivý stav.** Jakmile jednou padne, padá na každý
     * další požadavek už napořád — takže řádek na požadavek znamená neomezený
     * růst logu, který si spustí kdokoli. Naměřeno toutéž revizí: 25 požadavků
     * proti rozbitému ovládacímu souboru dalo 25 řádků, každý s absolutní
     * cestou k němu.
     */
    it('lepivé odmítnutí stropem se zapíše jednou za proces, ne jednou za požadavek', async () => {
      const logged = captureOperatorLog();
      const dir = mkdtempSync(join(tmpdir(), 'worldsmith-route-'));
      temporary.push(dir);
      const path = join(dir, 'spend-cap.json');
      writeFileSync(path, 'tohle není JSON', 'utf8');

      // Jedno načtení = jeden proces. Strop i záznam o zapsaných příčinách jsou
      // stav procesu, takže se `call()` volá opakovaně, ne `post()` dvacetkrát.
      const call = await loadRoute({ WORLDSMITH_SPEND_CAP_FILE: path });
      for (let attempt = 0; attempt < 25; attempt += 1)
        expect((await call(JSON.stringify({ prompt: FROZEN_CREATE.prompt }))).status).toBe(503);

      const lines = logged.filter((line) => line.includes('CONTROL_UNREADABLE'));
      expect(lines, '25 požadavků napsalo operátorovi víc než jeden řádek').toHaveLength(1);
      // První výskyt musí nést všechno, protože druhý nebude.
      expect(lines[0]).toContain(path);
    });
  });
});
