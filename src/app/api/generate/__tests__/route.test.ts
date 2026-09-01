/**
 * Mapování výsledků řetězu na stavové kódy.
 *
 * Kontrakt samotného řetězu (pořadí článků, účtování, obě větve) drží
 * `src/server/__tests__/pipeline.test.ts`. Tady se testuje jen to, co přidává
 * HTTP vrstva — a co by jinak nikdo neověřil, protože rozdíl mezi 404 a 502 se
 * v žádném jiném testu neprojeví.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // **Nutné od 1. 9. 2026, kdy sem přibyl podvržený `process.cwd()`.** Bez
  // toho by špionáž na `cwd` přežila do dalších testů a ty by běžely nad
  // dočasným adresářem místo nad repozitářem — zelené z úplně jiného důvodu.
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ResponseBody {
  readonly requestId: string;
  readonly branch?: string;
  readonly emission?: unknown;
  /** Zůstat MÁ: počet tokenů je vlastnost volání, ne ceníku. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Zmizet MÁ: druhá polovina dvojice, ze které jde ceník dopočítat. */
  readonly costUsd?: number;
  readonly provenance?: Record<string, string | boolean>;
  readonly error?: { readonly code: string; readonly message: string; readonly category?: string };
}

/** Všechna jména klíčů v odpovědi, do libovolné hloubky. */
function keysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, into);
  else if (value !== null && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      into.push(key);
      keysDeep(inner, into);
    }
  return into;
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

/* ------------------------------------------------------------------ *
 * Korpus, který je celý v pořádku a jednu odpověď přesto nemá.
 * ------------------------------------------------------------------ */

const GAP_PROMPT = 'a room whose frozen answer went missing';
const GAP_ID = 'gap-create-1';

/**
 * Postaví ve **dočasném** adresáři zmrazený korpus, který projde všemi
 * kontrolami — hash souboru proti `MANIFEST.lock` i tvar záznamů — a přitom
 * v `responses/index.jsonl` odpověď na `GAP_ID` nemá.
 *
 * Nesahá se tím na `evals/frozen/`: `FROZEN_DIR` vzniká z `process.cwd()` při
 * načtení modulu, takže stačí podvrhnout `cwd` a shodit cache modulů. Je to týž
 * postup jako v `src/server/__tests__/public-faults.test.ts`, jen tam je
 * adresář prázdný a tady je korpus platný a neúplný — což je přesně ten rozdíl,
 * který se měří.
 */
function corpusWithoutOneAnswer(
  fault: 'missing' | 'tampered' | 'unreadable' = 'missing',
): { readonly log: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-gap-'));
  temporary.push(dir);
  const frozen = join(dir, 'evals', 'frozen');
  mkdirSync(join(frozen, 'responses'), { recursive: true });

  // Protokol se opisuje ze skutečného korpusu, protože z něj `frozenGrammar()`
  // skládá slovník a routa se bez něj k větvi vůbec nedostane.
  const protocol = readFileSync('evals/frozen/protocol.v1.json', 'utf8').replace(/\r\n/g, '\n');
  const prompts = `${JSON.stringify({ id: GAP_ID, kind: 'create', prompt: GAP_PROMPT })}\n`;

  // Soubor odpovědí existuje a hashuje se správně; rozbitá je jen odpověď na
  // `GAP_ID`, a to dvěma způsoby, které se soudí oba. Prázdný soubor by se
  // choval jako nečitelný korpus, což je vada, kterou už měří jiná sada.
  const other = { branch: 'create', forPrompt: 'some-other-prompt', synthetic: true, body: { emitted: true } };
  const lines = [
    JSON.stringify({
      ...other,
      sha256: createHash('sha256').update(JSON.stringify(other.body)).digest('hex'),
    }),
  ];
  // `tampered`: záznam **je** na místě, jen se rozešel s vlastním otiskem —
  // podvržená odpověď, ne chybějící. Zvenku to musí být totéž.
  if (fault === 'tampered')
    lines.push(
      JSON.stringify({
        branch: 'create',
        forPrompt: GAP_ID,
        synthetic: true,
        body: { emitted: true },
        sha256: '0'.repeat(64),
      }),
    );
  const responses = `${lines.join('\n')}\n`;

  const files: Record<string, string> = {
    'protocol.v1.json': protocol,
    'prompts.v1.jsonl': prompts,
    // `unreadable`: soubor odpovědí **není**, zbytek korpusu je v pořádku.
    // Je to jediná cesta, jak se dostat k `UPSTREAM_UNAVAILABLE` z větve
    // zdarma: slovník i seznam promptů projdou, takže routa dojde až do
    // generování, a teprve tam se čtení souboru odpovědí rozbije. Prázdný
    // adresář by ji zastavil dřív, u `frozenGrammar()`.
    ...(fault === 'unreadable' ? {} : { 'responses/index.jsonl': responses }),
  };
  const manifest: Record<string, string> = {};
  for (const [relative, contents] of Object.entries(files)) {
    writeFileSync(join(frozen, relative), contents, 'utf8');
    manifest[relative] = createHash('sha256').update(Buffer.from(contents, 'utf8')).digest('hex');
  }
  writeFileSync(join(frozen, 'MANIFEST.lock'), JSON.stringify({ files: manifest }), 'utf8');

  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const log: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    log.push(String(line));
  });
  vi.resetModules();
  return { log };
}

describe('POST /api/generate', () => {
  it('vydá emisi z offline větve, když prostředí neříká jinak', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    expect(status).toBe(200);
    expect(json.branch).toBe('mock');
    expect(typeof json.emission).toBe('object');
    // Že offline větev nic nestojí, se od 1. 9. 2026 nesoudí přes `costUsd` —
    // ten se ven neposílá vůbec (viz blok o ceníku dole). Tvrzení zůstalo,
    // jen ho nese spotřeba, a ta je u zmrazené odpovědi nulová.
    expect(json.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(json.costUsd).toBeUndefined();
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

  /**
   * **Naměřeno nezávislou revizí 1. 9. 2026: 250 požadavků = 250 řádků.**
   * `BRANCH_UNCONFIGURED` mělo v tabulce `always`, jenže tady se nikam nevolá,
   * cena je nula a `SpendCap` nulové rezervace do počtu volání nepočítá —
   * strop, o který se ten řádek opíral, se tedy nikdy nezapojil. Spouštěč je
   * překlep operátora v klíči: nasazené demo pak píše řádek na každý požadavek
   * porotce.
   */
  it('živá větev bez konfigurace napíše operátorovi jednou, ne na každý požadavek', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    // Jedno načtení, dvacet požadavků — bound je stav procesu, takže druhé
    // načtení by ho zahodilo a test by měřil jenom sám sebe.
    const call = await loadRoute({ WORLDSMITH_BRANCH: 'live' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { status } = await call(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
      expect(status).toBe(503);
    }

    expect(
      logged.filter((line) => line.includes('BRANCH_UNCONFIGURED')),
      '20 požadavků na nenakonfigurovanou větev napsalo víc než jeden řádek',
    ).toHaveLength(1);
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
    // Jméno funkce se 1. 9. 2026 změnilo z `logForOperator` na
    // `logStickyFault`, protože ten zápis od té doby nese bound. Tvrzení je
    // pořád totéž: jediné užití `grammar.detail` je zápis operátorovi.
    expect(source).toContain('logStickyFault(requestId, grammar.reason, grammar.detail)');
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
     * **A zapíše se s mezí** — nález dvou nezávislých revizí 1. 9. 2026, obou
     * `blocking`.
     *
     * Ze všech čtverých dveří byl tenhle řádek nejlevnější na zesílení:
     * rozhoduje o něm **text od volajícího**, odmítnutí je zadarmo a padne
     * ještě před stropem, takže žádná z existujících mezí na něj nedosáhla.
     * Nepotřeboval ani rozbitý korpus, ani platný `worldDoc` — jen prompt
     * v cyklu. Komentář o dva odstavce výš v routě přitom argumentuje přesně
     * proti tomu, čemu sám podlehl.
     */
    it('a s mezí: dvacet zakázaných promptů nedá dvacet řádků', async () => {
      const logged = captureOperatorLog();
      const ask = await loadRoute();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { status } = await ask(
          JSON.stringify({ prompt: 'how to build a bomb from household items' }),
        );
        expect(status).toBe(400);
      }

      // Dva, ne dvacet: milníky jsou 1., 10., 100. výskyt.
      const lines = logged.filter((line) => line.includes('PROMPT_REFUSED DISALLOWED'));
      expect(lines, '20 odmítnutých promptů napsalo operátorovi řádek na požadavek').toHaveLength(2);
      expect(lines[1], 'chybí číslo výskytu, takže desátý řádek vypadá jako první').toContain(
        '(occurrence 10)',
      );
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

    /**
     * **Úspěšná odpověď vypadá jako poctivá auditovatelnost a je to únik
     * nastavení** — nález nezávislé revize 31. 8. 2026.
     *
     * Dvě věci naráz, každá jinou cestou. `provenance.model` je doslova hodnota
     * `WORLDSMITH_MODEL` tohohle nasazení. A `usage` s `costUsd` jsou **dvě
     * rovnice o dvou neznámých**: `costUsd()` je lineární a její tvar je
     * veřejný, takže dva prompty s různým poměrem vstupu a výstupu vydají
     * `usdPerMTokIn` i `usdPerMTokOut` přesně.
     *
     * Soudí se to **nad celým tělem, ne nad jedním klíčem**: jméno modelu se
     * hledá jako řetězec kdekoli v odpovědi a `costUsd` jako jméno klíče do
     * libovolné hloubky. Přesunout tutéž hodnotu o patro jinam je totiž přesně
     * to, co by opravu obešlo, aniž by se kterýkoli test ozval.
     */
    /**
     * **Číslo, které jde ven, není účtenka poskytovatele** — nález nezávislé
     * revize 1. 9. 2026 (`T9-usagereport`, LOW). Routa to pole odůvodňovala
     * jako poctivou vlastnost volání, jenže `readableUsage()` podhlášený výstup
     * zvedne na hranici odvozenou z délky textu. Rozhodnutí bylo přepsat popis,
     * ne rozdělit pole: publikovat účtenku, kterou si server odmítl nechat pro
     * účet, je horší odpověď než popsat, co to číslo je.
     *
     * Testuje se to obojí naráz, protože ani jedna půlka sama nestačí. Chování
     * ukazuje, že se číslo dopočítává; lexikální aserce hlídá, že to routa
     * nepopisuje jinak — a to je celý ten nález, protože vada nebyla v čísle.
     */
    it('hlášená spotřeba je účetní základ, a routa to tak i popisuje', async () => {
      // 3000 znaků textu dá hranici 250 výstupních tokenů (dělitel 12).
      const pad = 'x'.repeat(3000 - JSON.stringify({ emitted: true, pad: '' }).length);
      const emission = JSON.stringify({ emitted: true, pad });
      expect(emission).toHaveLength(3000);

      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          Response.json({
            content: [{ type: 'text', text: emission }],
            usage: { input_tokens: 0, output_tokens: 1 },
          }),
        ),
      );

      const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_USD: '1000',
      });

      expect(status).toBe(200);
      // Poskytovatel řekl 1. Ven jde 250 — účetní základ, ne spálená spotřeba.
      expect(json.usage).toEqual({ inputTokens: 0, outputTokens: 250 });

      const source = readFileSync(new URL('../route.ts', import.meta.url), 'utf8');
      // Věta, která tu stála do 1. 9. 2026 a slibovala spálené tokeny.
      expect(source, 'routa pořád slibuje spotřebu, kterou nevrací').not.toContain('kolik toho model');
      expect(source, 'popis účetního základu z routy zmizel').toContain('ze kterého se počítal účet');
    });

    it('úspěch nevydá ceník ani jméno modelu, a poctivost si nechá', async () => {
      const model = 'privately-pinned-model-7c1f';
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          Response.json({
            content: [{ type: 'text', text: '{"emitted":true}' }],
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
        ),
      );

      const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_MODEL: model,
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_USD: '1000',
      });

      expect(status).toBe(200);
      expect(JSON.stringify(json), 'ven odešlo jméno modelu z prostředí').not.toContain(model);
      expect(keysDeep(json), 'ven odešla druhá polovina dvojice na ceník').not.toContain('costUsd');

      // A ticho nesmí být proto, že se ořezalo všechno. Doklad o původu je
      // důvod, proč `provenance` v odpovědi vůbec je (RUN-01).
      expect(json.provenance?.source).toBe('upstream-http');
      expect(json.provenance?.synthetic).toBe(false);
      expect(json.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    });

    /**
     * **Účetní řádek byl pátá cesta téže třídy** — nález kontrolní revize nad
     * `cdf2c06` (tedy nad commitem, který ty první čtyři zavřel), `VERDICT:
     * blocking`.
     *
     * Opíral se přesně o tu větu, kterou ten commit vyvrátil: „účtovat je co jen
     * u placeného volání a ta omezuje strop". Jenže strop je paměť procesu,
     * kterou chladný start nuluje, a nad `{"enabled":false,"capUsd":0}` neplatí vůbec (samotné `enabled:false` je rozbitý vypínač, ne vypnutý strop) —
     * naměřeno 250 požadavků = 250 řádků, každý se jménem modelu z prostředí.
     *
     * **Dopsat `model` do `PUBLIC_PROVENANCE` by to nezavřelo** a je to slepá
     * ulička, ne menší varianta: řádek vyrobí už samo `costUsd > 0`, takže by
     * se rozhodnutí o schovaném jménu modelu zrušilo za nic.
     */
    it('účetní řádek má mez, a součet se tím neztratí', async () => {
      const logged = captureOperatorLog();
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          Response.json({
            content: [{ type: 'text', text: '{"emitted":true}' }],
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
        ),
      );

      const ask = await loadRoute({
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_MODEL: 'privately-pinned-model-7c1f',
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        // **Strop je pět dolarů, ne tisíc, a je to součást měření**: krok je
        // setina skutečného stropu, takže nad tisícem by byl 10 USD a sto
        // padesát volání za 0,50 USD by nenapsalo nic než první řádek.
        WORLDSMITH_SPEND_CAP_USD: '5',
      });

      // Jedno volání stojí (100 × 3 + 200 × 15) / 1e6 = 0,0033 USD.
      //
      // **150, a nesmí to být milník.** Do 1. 9. 2026 tu stálo 100 a test tím
      // nedokázal chytit implementaci, kterou měl hlídat — nález kontrolní
      // revize, ověřený mutací. 100 je totiž samo milníkem (1., 10., 100.),
      // takže milníková verze napsala poslední řádek přesně na posledním volání
      // a zaostala o 0,000 USD; všech šest tvrzení pod tím prošlo i nad kódem,
      // který tenhle commit odstraňuje. Při 150 zaostane o 0,165 USD, tedy
      // 3,3násobek kroku, a test zčervená.
      const CALLS = 150;
      const PER_CALL = 0.0033;
      for (let attempt = 0; attempt < CALLS; attempt += 1) {
        const { status } = await ask(JSON.stringify({ prompt: 'bludiště s klíčem' }));
        expect(status).toBe(200);
      }

      const lines = logged.filter((line) => line.includes('ACCOUNTING'));
      const totalOf = (line: string): number =>
        Number(/totalUsd=([0-9.]+)/.exec(line)?.[1] ?? Number.NaN);

      // **Mez je v dolarech, ne v požadavcích** — krok je setina stropu, tedy
      // nad stropem 5 USD pět centů. Sto padesát volání za 0,495 USD proto dá
      // nejvýš jedenáct řádků…
      const step = 5 / 100;
      expect(
        lines.length,
        `${CALLS} volání napsalo operátorovi řádek na požadavek`,
      ).toBeLessThanOrEqual(Math.ceil((CALLS * PER_CALL) / step) + 1);
      expect(lines.length, 'operátor se o utrácení nedozvěděl vůbec').toBeGreaterThan(1);

      // …a hlavně: **poslední řádek nesmí zaostat za skutečností o víc než krok**.
      // Tohle je ta vlastnost, kterou milníky neuměly — u nich stál poslední
      // řádek na 40 % skutečné útraty a nic to nepoznalo.
      const spent = CALLS * PER_CALL;
      expect(spent - totalOf(lines[lines.length - 1])).toBeLessThanOrEqual(step + 1e-9);

      // A součet je za **všechna** volání, ne jen za zapsaná: první řádek se
      // píše vždycky (že nasazení začalo utrácet, se propásnout nesmí), takže
      // stojí přesně na jednom volání.
      expect(lines[0]).toContain(`totalUsd=${PER_CALL.toFixed(6)}`);
      // Cena toho jednoho volání zůstává vedle součtu; bez ní se z řádku nepozná
      // ceník, jen celková útrata.
      expect(lines[0]).toContain('costUsd=0.0033');
    });

    /**
     * **Zvednutý strop nesmí znásobit počet řádků** — nález kontrolní revize
     * 1. 9. 2026, naměřený 200násobek.
     *
     * Krok byl `DEFAULT_CAP_USD / 100`, tedy pevných 5 centů z literálu
     * v `spend-cap.ts`, jenže skutečný strop nese prostředí. Nad stropem
     * 1000 USD to dávalo mez `1000 / 0,05` = **20 000 řádků za proces** proti
     * slíbené stovce — a komentář u toho tvrdil „když se strop zvedne, zvedne
     * se s ním". Teď je krok setina **skutečného** stropu, takže mez v počtu
     * řádků na stropu nezávisí vůbec.
     */
    it('dvěstěkrát vyšší strop nedá dvěstěkrát víc účetních řádků', async () => {
      const logged = captureOperatorLog();
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          Response.json({
            content: [{ type: 'text', text: '{"emitted":true}' }],
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
        ),
      );

      const ask = await loadRoute({
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_MODEL: 'privately-pinned-model-7c1f',
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        // Týž běh jako test nad tímhle, jen strop je dvěstěkrát vyšší.
        WORLDSMITH_SPEND_CAP_USD: '1000',
      });

      for (let attempt = 0; attempt < 150; attempt += 1) {
        const { status } = await ask(JSON.stringify({ prompt: 'bludiště s klíčem' }));
        expect(status).toBe(200);
      }

      // Sto padesát volání za 0,495 USD proti kroku 10 USD: **jediný** řádek,
      // ten povinný první. S pevným krokem jich bylo jedenáct, tedy tolik, co
      // při dvěstěkrát nižším stropu — což je právě ta neúměra.
      const lines = logged.filter((line) => line.includes('ACCOUNTING'));
      expect(lines, 'krok se neodvozuje ze skutečného stropu').toHaveLength(1);
    });

    /**
     * **Účtenka, která není konečné číslo, nesmí mez zrušit** — nález kontrolní
     * revize 1. 9. 2026.
     *
     * `usageOf()` (`src/server/upstream.ts`) pouští `Infinity` od poskytovatele
     * dál schválně, protože ho zahodí `release()` ve stropu. `logAccounting` je
     * ale **druhý** konzument téhož čísla: jediné `1e999` udělá z běžícího
     * součtu `Infinity`, `Infinity - Infinity` je `NaN`, porovnání s krokem je
     * napořád nepravda — a od té chvíle píše řádek **každý** placený požadavek.
     * Mez by zmizela přesně u toho poskytovatele, kvůli kterému se log čte.
     */
    it('otrávená účtenka se do součtu dostane jako to, co strop strhl', async () => {
      const logged = captureOperatorLog();
      // `Response.json` by `Infinity` uložilo jako `null`, takže tělo musí jít
      // jako text — `JSON.parse('1e999')` dá `Infinity` typu number.
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response(
            '{"content":[{"type":"text","text":"{\\"emitted\\":true}"}],"usage":{"input_tokens":1e999,"output_tokens":1}}',
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      );

      const ask = await loadRoute({
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_MODEL: 'privately-pinned-model-7c1f',
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_USD: '1000',
      });

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const { status } = await ask(JSON.stringify({ prompt: 'bludiště s klíčem' }));
        expect(status).toBe(200);
      }

      // **Šest požadavků, jeden řádek** — mez drží krok v dolarech (setina
      // stropu, tedy 10 USD), a šest rezervací po ~0,13 USD ho nepřekročí.
      const accounting = logged.filter((line) => line.includes('ACCOUNTING'));
      expect(accounting, 'otrávená účtenka píše řádek na požadavek').toHaveLength(1);

      // **A tohle je ta změna z 1. 9. 2026, ne jen jiné číslo výš.** Dokud se
      // otrávená částka ořezávala až tady u konzumenta, řádek nevznikl vůbec
      // (`Infinity` se do součtu nepustil) — takže těch ~0,8 USD, které strop
      // doopravdy strhl, nebylo v logu **nikde**. Součet teď nese strženou
      // rezervaci, protože `runPipeline` hlásí to, co `settle()` odečetl.
      const totalUsd = Number(/totalUsd=([0-9.]+)/.exec(accounting[0]!)?.[1]);
      expect(Number.isFinite(totalUsd), accounting[0]).toBe(true);
      expect(totalUsd).toBeGreaterThan(0);
      // Ne cena té otrávené účtenky, ale rezervace jednoho volání.
      expect(totalUsd).toBeLessThan(1);
    });

    /**
     * **Selhání, které stálo peníze, se do součtu počítá taky** — nález
     * nezávislé revize 1. 9. 2026, `VERDICT: blocking`.
     *
     * `BILLED_ON_FAILURE` (`src/server/pipeline.ts`) účtuje `MALFORMED_RESPONSE`
     * i `UPSTREAM_UNAVAILABLE` rezervací, protože poskytovatel odpověděl a to se
     * platí. Dokud se přičítalo jen z úspěchů, `totalUsd` podhlašovalo právě
     * tehdy, když poskytovatel zlobí — tedy směrem, který peníze schovává, a
     * v logu nebylo čím ten rozdíl vysvětlit.
     */
    it('a selhání, které se účtuje, se do součtu započítá', async () => {
      const logged = captureOperatorLog();
      // Odpoví 200 s tělem, které server nepřečte → `MALFORMED_RESPONSE`,
      // účtované rezervací.
      vi.stubGlobal('fetch', () =>
        Promise.resolve(Response.json({ content: [{ type: 'text', text: 'not json at all' }] })),
      );

      const ask = await loadRoute({
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_MODEL: 'privately-pinned-model-7c1f',
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_USD: '1000',
      });

      const { status } = await ask(JSON.stringify({ prompt: 'bludiště s klíčem' }));
      expect(status, 'fixtura přestala být účtovaným selháním').toBe(502);

      const accounting = logged.filter((line) => line.includes('ACCOUNTING'));
      expect(accounting, 'zaplacené selhání se do účetnictví nedostalo').toHaveLength(1);

      // **Musí to být celá rezervace, ne „nějaké číslo nad nulou".** Pouhé
      // `> 0` tady stálo do 1. 9. 2026 a kontrolní revize na něm ukázala
      // přeživšího mutanta: implementace, která by účtovala pár tokenů místo
      // rezervace, by tou asercí prošla. Dolní hranice se odvozuje, ne opisuje —
      // rezervace je `vstupní tokeny × cena_in + maxOutputTokens × cena_out`,
      // takže i bez znalosti délky promptu je nejméně 8000 × 15 / 1e6.
      const RESERVATION_FLOOR = (8000 * 15) / 1_000_000;
      expect(
        Number(/totalUsd=([0-9.]+)/.exec(accounting[0])?.[1] ?? 0),
        'účtované selhání se zaúčtovalo méně než celou rezervací',
      ).toBeGreaterThanOrEqual(RESERVATION_FLOOR);
    });

    it('zmrazená větev si nechá celou svoji stopu, protože je to veřejný artefakt', async () => {
      // Druhá půlka téhož: výčet povolených klíčů se nesmí splést s „ořízni
      // provenance". Čtveřice zmrazené větve popisuje commitnutý soubor
      // v repozitáři, ne nastavení serveru, a bez ní není čím doložit, že
      // odpověď nevznikla za běhu.
      const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));

      expect(status).toBe(200);
      expect(json.provenance?.source).toBe('frozen-manifest');
      expect(json.provenance?.file).toBe('responses/index.jsonl');
      expect(typeof json.provenance?.bodySha256).toBe('string');
      expect(typeof json.provenance?.declaredVerdict).toBe('string');
      expect(json.provenance?.promptId).toBe(FROZEN_CREATE.id);
    });

    it('co se z odpovědi zahodí, dojde operátorovi celé', async () => {
      // Ořezat ven se smí jen tak, aby to operátor pořád našel — táž doktrína
      // jako u adresy poskytovatele. Bez tohohle řádku by nasazení, které jede
      // na jiném modelu, než si operátor myslí, nešlo poznat odnikud.
      const logged = captureOperatorLog();
      const model = 'privately-pinned-model-7c1f';
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          Response.json({
            content: [{ type: 'text', text: '{"emitted":true}' }],
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
        ),
      );

      const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
        WORLDSMITH_BRANCH: 'live',
        WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
        WORLDSMITH_MODEL_KEY: 'test-key',
        WORLDSMITH_MODEL: model,
        WORLDSMITH_USD_PER_MTOK_IN: '3',
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_SPEND_CAP_USD: '1000',
      });
      expect(status).toBe(200);

      const operator = logged.join('\n');
      expect(operator, 'operátor se nedozvěděl, na jakém modelu to běží').toContain(model);
      // (100 × 3 + 200 × 15) / 1e6
      expect(operator, 'operátorovi chybí cena volání').toContain('costUsd=0.0033');
      expect(operator).toContain(String(json.requestId));
    });

    /**
     * **Ten účetní řádek je omezený tím, co ho vyrábí, ne tím, kdo ho volá.**
     *
     * Endpoint nechce přihlášení (AC T301), takže řádek na úspěšný požadavek by
     * znamenal neomezený růst logu, který si spustí kdokoli — táž vada jako
     * u lepivého odmítnutí stropem o kus výš. Offline větev ale nic nestojí
     * a v `provenance` nezadržuje nic, takže **nemá co účtovat** a mlčí; na
     * placené větvi je počet těch řádků shora omezený stropem počtu volání,
     * tedy týmž mechanismem, který omezuje peníze.
     */
    it('úspěch na offline větvi nenapíše operátorovi nic, ať jich přijde kolik chce', async () => {
      const logged = captureOperatorLog();
      const call = await loadRoute();

      for (let attempt = 0; attempt < 20; attempt += 1)
        expect((await call(JSON.stringify({ prompt: FROZEN_CREATE.prompt }))).status).toBe(200);

      expect(logged, 'úspěch zdarma dokáže psát operátorovi na stderr').toEqual([]);
    });

    /**
     * **`NO_SOURCE` mlčel za dvě různé věci, a jedna z nich je porucha** —
     * nález nezávislé revize 1. 9. 2026.
     *
     * „Porotce napsal vlastní větu" je u offline větve normální odpověď a
     * logovat se nemá; `RULES.md` §3.3 mu ty pokusy výslovně dovoluje. „Prompt
     * v korpusu je, ale odpověď k němu chybí" je proti tomu díra ve zmrazené
     * sadě, o které se nikdo nedozví, dokud ji někdo netrefí. Do téhle opravy
     * nesly obě situace **týž důvod**, takže filtr logu neměl podle čeho je
     * rozlišit a mlčel na obě.
     */
    it('chybějící odpověď na známý prompt dojde operátorovi, neznámá věta ne', async () => {
      const { log } = corpusWithoutOneAnswer();
      const { POST } = await import('../route');
      const ask = async (prompt: string) => {
        const response = await POST(
          new Request('http://127.0.0.1/api/generate', { method: 'POST', body: JSON.stringify({ prompt }) }),
        );
        return { status: response.status, json: (await response.json()) as ResponseBody };
      };

      const gap = await ask(GAP_PROMPT);
      expect(gap.status).toBe(404);
      const operator = log.join('\n');
      expect(operator, 'díra v korpusu se nedozvěděl nikdo').toContain('NO_FROZEN_ANSWER');
      expect(operator, 'operátorovi chybí záznam, který má doplnit').toContain(GAP_ID);
      expect(operator).toContain(String(gap.json.requestId));

      // A ticho u té benigní musí zůstat tichem.
      const before = log.length;
      const unknown = await ask('a sentence this corpus has never heard of');
      expect(unknown.status).toBe(404);
      expect(log.length, 'vlastní věta porotce napsala operátorovi řádek').toBe(before);
    });

    /**
     * **Zvenku se ty dvě situace rozeznat nesmí.** „Mám rozbitý korpus" je stav
     * serveru; kdyby ho odpověď prozradila kódem nebo textem, dal by se korpus
     * obcházet po záznamech a zjistit, které chybí. Soudí se proto celá
     * odpověď, ne jen její kus — jediné, co se smí lišit, je korelační ID.
     */
    it('díra v korpusu vypadá zvenku přesně jako neznámá věta', async () => {
      corpusWithoutOneAnswer();
      const { POST } = await import('../route');
      const ask = async (prompt: string) => {
        const response = await POST(
          new Request('http://127.0.0.1/api/generate', { method: 'POST', body: JSON.stringify({ prompt }) }),
        );
        const { requestId, ...rest } = (await response.json()) as ResponseBody & Record<string, unknown>;
        expect(typeof requestId).toBe('string');
        return { status: response.status, body: rest };
      };

      const gap = await ask(GAP_PROMPT);
      const unknown = await ask('a sentence this corpus has never heard of');
      expect(gap.status).toBe(unknown.status);
      expect(gap.body).toEqual(unknown.body);
      expect(gap.body).toMatchObject({ error: { code: 'NO_SOURCE' } });
    });

    /**
     * **Vada korpusu je lepivá**, takže řádek na požadavek by byl log, který si
     * kdokoli natáhne donekonečna — táž vada jako u odmítnutí stropem výš.
     * Klíčem je konkrétní záznam, ne důvod: tisíc požadavků na jednu díru dá
     * jeden řádek, ale tři díry dají tři.
     */
    it('vada korpusu se zapíše jednou za záznam, ne jednou za požadavek', async () => {
      const { log } = corpusWithoutOneAnswer();
      const { POST } = await import('../route');

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await POST(
          new Request('http://127.0.0.1/api/generate', {
            method: 'POST',
            body: JSON.stringify({ prompt: GAP_PROMPT }),
          }),
        );
        expect(response.status).toBe(404);
      }

      expect(
        log.filter((line) => line.includes('NO_FROZEN_ANSWER')),
        '20 požadavků napsalo operátorovi víc než jeden řádek',
      ).toHaveLength(1);
    });

    /**
     * **Sourozenec téže vady, naměřený nezávislou revizí 1. 9. 2026.**
     *
     * „Odpověď chybí" a „odpověď je na místě, ale rozešla se s vlastním
     * otiskem" jsou obojí díra v jednom záznamu zmrazené sady. Dokud o tom
     * rozhodoval ternár na jediném důvodu, spadl ten druhý do „nedovolali jsme
     * se k modelu": **502 a řádek na každý požadavek**, tedy přesně to, čemu se
     * u jeho dvojčete zabraňovalo — a k tomu vzkaz „tenhle prompt tvůj korpus
     * zná", který je stav serveru.
     */
    it('podvržený záznam vypadá zvenku stejně jako chybějící, a taky se zapíše jen jednou', async () => {
      const { log } = corpusWithoutOneAnswer('tampered');
      const { POST } = await import('../route');
      const ask = async (prompt: string) => {
        const response = await POST(
          new Request('http://127.0.0.1/api/generate', { method: 'POST', body: JSON.stringify({ prompt }) }),
        );
        const { requestId, ...rest } = (await response.json()) as ResponseBody & Record<string, unknown>;
        return { status: response.status, body: rest };
      };

      const tampered = await ask(GAP_PROMPT);
      const unknown = await ask('a sentence this corpus has never heard of');
      expect(tampered.status, 'podvržený záznam odpovídá jinak než neznámá věta').toBe(404);
      expect(tampered.body).toEqual(unknown.body);

      // Operátor to naopak vědět má — a je to vada záznamu, ne modelu.
      const operator = log.join('\n');
      expect(operator, 'operátor dostal „nedovolali jsme se k modelu"').not.toContain(
        'UPSTREAM_UNAVAILABLE',
      );
      // **Musí to být dvojice, ne samotné slovo.** `toContain('RESPONSE_TAMPERED')`
      // tu stálo do 1. 9. 2026 a bylo bezvýznamné: i před opravou zněl řádek
      // `UPSTREAM_UNAVAILABLE RESPONSE_TAMPERED: …`, tedy to slovo obsahoval taky.
      // Ověřeno mutací — celý test drží dvě jiné aserce. Tuhle dvojici umí
      // vyrobit jen tabulka, která podvržený záznam posílá na `NO_FROZEN_ANSWER`.
      expect(operator, 'vada záznamu se operátorovi ohlásila jiným důvodem').toMatch(
        /NO_FROZEN_ANSWER\W+RESPONSE_TAMPERED/,
      );

      const before = log.length;
      for (let attempt = 0; attempt < 20; attempt += 1) await ask(GAP_PROMPT);
      expect(log.length, '20 požadavků na podvržený záznam psalo operátorovi pořád dokola').toBe(
        before,
      );
    });

    /**
     * **Větev zdarma taky umí `UPSTREAM_UNAVAILABLE`, a to celou tabulku
     * vyvrátilo** — nález dvou nezávislých revizí 1. 9. 2026.
     *
     * `OPERATOR_LOG` mu dávalo `always` na základě věty „bez odchozího volání
     * nevznikne, a placená volání omezuje strop". Obojí je nepravda: offline
     * větev ho vrací u rozbitého korpusu, `pipeline.ts` na něj překládá
     * jakoukoli výjimku z generování, a `SpendCap` **nulové rezervace do počtu
     * volání nepočítá**, takže strop se nezapojí vůbec.
     *
     * Spouštěč není útočník, ale neúplné nasazení: `evals/frozen/**` se
     * nezabalí celý, protokol i seznam promptů projdou, a teprve soubor
     * odpovědí chybí. Každý požadavek pak psal řádek s absolutní cestou na
     * disku serveru včetně jména účtu.
     */
    it('vada, kterou umí i větev zdarma, se zapisuje s mezí', async () => {
      const { log } = corpusWithoutOneAnswer('unreadable');
      const { POST } = await import('../route');

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await POST(
          new Request('http://127.0.0.1/api/generate', {
            method: 'POST',
            body: JSON.stringify({ prompt: GAP_PROMPT }),
          }),
        );
        // Rozbité prostředí, ne chybějící odpověď — 404 by ho vydalo jako
        // naměřený výsledek.
        expect(response.status).toBe(502);
      }

      // Dva, ne dvacet: milníky jsou 1., 10., 100. výskyt.
      const lines = log.filter((line) => line.includes('UPSTREAM_UNAVAILABLE'));
      expect(lines, '20 požadavků napsalo operátorovi řádek na požadavek').toHaveLength(2);
      expect(lines[1]).toContain('(occurrence 10)');
    });
  });
});
