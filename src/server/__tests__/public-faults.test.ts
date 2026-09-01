/**
 * **Jedna kořist, čtvery dveře.**
 *
 * `readFrozen()` (`src/model/client.ts:118`) skládá detail jako
 * „<soubor> is not readable under <FROZEN_DIR>", kde `FROZEN_DIR` je
 * `join(process.cwd(), 'evals', 'frozen')` — **absolutní cesta na disku serveru
 * včetně jména účtu**. `/api/generate` to přestal posílat ven 31. 8. 2026, ale
 * `/api/emit`, `/api/emit/stream` a `/api/edit` vracely `failure.detail` doslova
 * dál. Nezávislá revize našla, že opravené byly jedny dveře ze čtyř.
 *
 * ## Proč se to dá měřit, i když se na zmrazenou sadu sahat nesmí
 *
 * Předchozí kolo to soudilo **grepem nad zdrojem** routy, protože vyrobit
 * nečitelný korpus by znamenalo rozbít `evals/frozen/` na disku. Grep ale
 * neměří chování: přežil by refaktor, který ten výraz přepíše, a neřekne nic
 * o třech ostatních dveřích.
 *
 * Tady se proto nesahá na korpus, ale na **`process.cwd()`**: `FROZEN_DIR` z něj
 * vzniká při načtení modulu, takže stačí ukázat na prázdný dočasný adresář
 * a `vi.resetModules()`. Korpus je pak doopravdy nečitelný, routa jede celou
 * svou skutečnou cestou a soudí se to, co vylezlo ven — ne to, jak je to
 * napsané. Zmrazená sada se přitom nedotkne.
 *
 * ## Co se soudí
 *
 * 1. ven jde **veřejný text**, stejný pro všechny čtvery dveře;
 * 2. v odpovědi není ani devítiznakový kus té cesty — z kratšího se hostitel
 *    ani jméno účtu poskládat nedá;
 * 3. operátorovi ta cesta naopak **dojde**, spárovaná korelačním ID. Ořezat ven
 *    bez toho by vyměnilo jednu vadu za druhou.
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { peelEnvelope, sealSimHash, type WorldDoc } from '../../ir/worlddoc';
import {
  MAX_DETAILS_PER_WINDOW,
  PUBLIC_CORPUS_FAULT,
  RATE_LIMIT_WINDOW_MS,
  STICKY_WINDOW_MS,
  withoutCredentials,
} from '../public-faults';

/* ------------------------------------------------------------------ *
 * Fixtura. Čte se ze SKUTEČNÉHO adresáře, tedy dřív, než se `cwd` podvrhne.
 * ------------------------------------------------------------------ */

interface FrozenResponse {
  readonly branch: string;
  readonly forPrompt: string;
  readonly body: unknown;
}

const responses = readFileSync('evals/frozen/responses/index.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as FrozenResponse);

const editRecord = responses.find((record) => record.branch === 'edit');
if (editRecord === undefined) throw new Error('the frozen corpus carries no edit response');

const createRecord = responses.find(
  (record) => record.branch === 'create' && record.forPrompt !== undefined,
);
if (createRecord === undefined) throw new Error('the frozen corpus carries no create response');

/** Základní svět zapečetěný přesně tak, jak ho pečetí `/api/emit`. */
const BASE_DOC: WorldDoc = (() => {
  const peeled = peelEnvelope(createRecord.body);
  if (peeled === null) throw new Error('the frozen create body is not an object');
  return sealSimHash(peeled.document as unknown as WorldDoc) as WorldDoc;
})();

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Prostředí bez korpusu.
 * ------------------------------------------------------------------ */

interface Doors {
  readonly dir: string;
  readonly log: string[];
}

/**
 * Ukáže `process.cwd()` na prázdný adresář a shodí cache modulů, aby si
 * `FROZEN_DIR` vzniklo znovu. Vrací tu cestu a pole, do kterého routa píše.
 */
function withoutCorpus(): Doors {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-nocorpus-'));
  temporary.push(dir);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const log: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    log.push(String(line));
  });
  vi.resetModules();
  return { dir, log };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Tvrzení, které platí u všech čtverých dveří stejně.
 *
 * Kus cesty se hledá po devíti znacích, ne celý řetězec: z kratšího se hostitel
 * ani jméno účtu poskládat nedá, z devíti ano. Je to táž míra, jakou se soudí
 * únik adresy poskytovatele v `src/app/api/generate/__tests__/route.test.ts`.
 */
function judge(door: string, sent: string, doors: Doors, requestId: string): void {
  expect(sent, `${door}: ven neodešel veřejný text`).toContain(
    PUBLIC_CORPUS_FAULT.CORPUS_UNREADABLE,
  );
  for (let at = 0; at + 9 <= doors.dir.length; at += 1)
    expect(sent, `${door}: ven odešel kus cesty „${doors.dir.slice(at, at + 9)}"`).not.toContain(
      doors.dir.slice(at, at + 9),
    );

  const operator = doors.log.join('\n');
  expect(operator, `${door}: operátor se o rozbitém korpusu nedozvěděl`).toContain(
    'CORPUS_UNREADABLE',
  );
  expect(operator, `${door}: operátorovi chybí cesta, kterou má opravit`).toContain(doors.dir);
  expect(operator, `${door}: řádek nejde spárovat s odpovědí`).toContain(requestId);
}

/* ------------------------------------------------------------------ *
 * Čtvery dveře.
 * ------------------------------------------------------------------ */

describe('a corpus fault says the same public sentence at every door', () => {
  it('/api/generate', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/generate/route');

    const response = await POST(post('http://127.0.0.1/api/generate', { prompt: 'a walled garden' }));
    const sent = await response.text();

    expect(response.status).toBe(503);
    judge('generate', sent, doors, (JSON.parse(sent) as { requestId: string }).requestId);
  });

  /**
   * **Rozbitý korpus je nejlepivější stav v tom souboru** — selže před moderací
   * i před stropem, tedy na **každém** požadavku, a varianta `CORPUS_UNREADABLE`
   * nese absolutní cestu na disku serveru včetně jména účtu. Do 1. 9. 2026ho
   * neomezovalo nic: naměřeno nezávislou revizí, 20 požadavků = 20 řádků,
   * každý s oběma hashi.
   *
   * Klíčem je `detail`, ne důvod, takže tenhle bound nezakryje **druhý**
   * rozbitý záznam — jen tisíc požadavků na tentýž.
   */
  it('/api/generate napíše vadu korpusu jednou, ne na každý požadavek', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/generate/route');

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await POST(post('http://127.0.0.1/api/generate', { prompt: 'a walled garden' }));
      expect(response.status).toBe(503);
    }

    expect(
      doors.log.filter((line) => line.startsWith('[generate] ')),
      '20 požadavků na rozbitý korpus napsalo víc než jeden řádek',
    ).toHaveLength(1);
  });

  it('/api/emit', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/emit/route');

    const response = await POST(post('http://127.0.0.1/api/emit', { promptId: 'C01' }));
    const sent = await response.text();

    expect(response.status).toBe(503);
    judge('emit', sent, doors, (JSON.parse(sent) as { requestId: string }).requestId);
  });

  /**
   * Rámec proudu je odpověď jako každá jiná — že jde po kouscích, na kořist nic
   * nemění. Tyhle dveře navíc odpovídají **200**, protože chyba přijde až
   * uvnitř proudu, takže by je kontrola nad stavovým kódem minula.
   */
  it('/api/emit/stream', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/emit/stream/route');

    const response = await POST(post('http://127.0.0.1/api/emit/stream', { promptId: 'C01' }));
    const sent = await response.text();

    expect(response.status).toBe(200);
    expect(sent).toContain('CORPUS_UNREADABLE');
    const frame = sent.slice(sent.indexOf('event: result'));
    const result = JSON.parse(frame.slice(frame.indexOf('{'), frame.lastIndexOf('}') + 1)) as {
      requestId: string;
    };
    judge('emit/stream', sent, doors, result.requestId);
  });

  it('/api/edit', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/edit/route');

    const response = await POST(
      post('http://127.0.0.1/api/edit', {
        promptId: editRecord.forPrompt,
        worldDoc: BASE_DOC,
        baseRevision: { sim: 0, look: 0 },
      }),
    );
    const sent = await response.text();

    expect(response.status).toBe(503);
    judge('edit', sent, doors, (JSON.parse(sent) as { requestId: string }).requestId);
  });
});

/* ------------------------------------------------------------------ *
 * Bound. Ne „říká se to stejně", ale „píše se to jednou".
 * ------------------------------------------------------------------ */

/**
 * **Do 1. 9. 2026 měl bound jen `/api/generate`, a byl v něm soukromý.**
 *
 * Dvě nezávislé revize téhož dne našly totéž a obě to označily za `blocking`:
 * zbylé troje dveře psaly operátorovi **řádek na požadavek** s absolutní cestou
 * na disku serveru včetně jména účtu. Sada výš to nechytila, protože soudila
 * jediný požadavek — jeden řádek vypadá stejně, ať je bound jakýkoli.
 */
describe('a corpus fault is one line per fault, not one per request, at every door', () => {
  const REQUESTS = 20;

  it('/api/emit', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/emit/route');

    for (let attempt = 0; attempt < REQUESTS; attempt += 1) {
      const response = await POST(post('http://127.0.0.1/api/emit', { promptId: 'C01' }));
      expect(response.status).toBe(503);
    }

    expect(
      doors.log.filter((line) => line.startsWith('[emit] ')),
      `${REQUESTS} požadavků napsalo operátorovi víc než jeden řádek`,
    ).toHaveLength(1);
  });

  it('/api/emit/stream', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/emit/stream/route');

    for (let attempt = 0; attempt < REQUESTS; attempt += 1) {
      // Tyhle dveře odpovídají 200 a vada přijde až rámcem uvnitř proudu, takže
      // se tělo musí dočíst — jinak se log zapíše až po aserci.
      const response = await POST(post('http://127.0.0.1/api/emit/stream', { promptId: 'C01' }));
      expect(await response.text()).toContain('CORPUS_UNREADABLE');
    }

    expect(
      doors.log.filter((line) => line.startsWith('[emit/stream] ')),
      `${REQUESTS} požadavků napsalo operátorovi víc než jeden řádek`,
    ).toHaveLength(1);
  });

  it('/api/edit', async () => {
    const doors = withoutCorpus();
    const { POST } = await import('../../app/api/edit/route');

    for (let attempt = 0; attempt < REQUESTS; attempt += 1) {
      const response = await POST(
        post('http://127.0.0.1/api/edit', {
          promptId: editRecord.forPrompt,
          worldDoc: BASE_DOC,
          baseRevision: { sim: 0, look: 0 },
        }),
      );
      expect(response.status).toBe(503);
    }

    expect(
      doors.log.filter((line) => line.startsWith('[edit] ')),
      `${REQUESTS} požadavků napsalo operátorovi víc než jeden řádek`,
    ).toHaveLength(1);
  });

  /**
   * **A tenhle případ nepotřebuje rozbitý korpus vůbec** — je to ten nejlevnější
   * ze všech a revize ho našla na **zdravém** commitnutém artefaktu.
   *
   * `BASE_WORLD_MISMATCH` neříká nic o serveru: říká, že volající poslal platný
   * svět a k němu `promptId` autorovaný proti jinému. To je běžný omyl klienta,
   * který si kdokoli zopakuje kolikrát chce, a demo ty světy samo vydává —
   * čtrnáct z patnácti dvojic tu podmínku splní. Do 1. 9. 2026 se logovalo
   * bezpodmínečně spolu s vadami korpusu, takže log rostl o řádek na požadavek.
   *
   * Bound je tu **na rychlosti, ne na lepivosti**, protože stav je volajícího:
   * kdyby byl lepivý, první omyl by kanál umlčel napořád a operátor by se
   * o skutečném rozchodu klienta s korpusem nedozvěděl nikdy.
   */
  it('/api/edit: rozešlá dvojice na zdravém korpusu taky, a rychlostí', async () => {
    const log = captureLog();
    vi.resetModules();
    const { POST } = await import('../../app/api/edit/route');

    for (let attempt = 0; attempt < REQUESTS; attempt += 1) {
      const response = await POST(
        post('http://127.0.0.1/api/edit', {
          promptId: editRecord.forPrompt,
          worldDoc: BASE_DOC,
          baseRevision: { sim: BASE_DOC.simRevision, look: BASE_DOC.lookRevision },
        }),
      );
      expect(response.status, 'fixtura přestala být rozešlou dvojicí').toBe(404);
    }

    // Dva, ne dvacet: milníky jsou 1., 10., 100. výskyt, takže dvacet
    // požadavků dá dva řádky a milion by dal sedm. Ani nula — kanál se nesmí
    // zavřít úplně, jinak zmizí jediný signál o tom, že se klient a korpus
    // rozešly.
    const lines = log.filter((line) => line.startsWith('[edit] '));
    expect(lines, `${REQUESTS} omylů klienta napsalo operátorovi řádek na požadavek`).toHaveLength(
      2,
    );
    expect(lines[0]).toContain('BASE_WORLD_MISMATCH');
    // Číslo výskytu je v textu schválně: bez něj vypadá desátý řádek jako první
    // a operátor záplavu nepozná.
    expect(lines[0]).toContain('(occurrence 1)');
    expect(lines[1]).toContain('(occurrence 10)');
  });
});

/* ------------------------------------------------------------------ *
 * Díra v korpusu proti omylu volajícího — týmiž dveřmi, týmž stavovým kódem.
 * ------------------------------------------------------------------ */

/**
 * Zmrazený korpus **s dírou**, postavený stranou.
 *
 * Editačním promptům z `missing` se odebere odpověď a `MANIFEST.lock` se
 * přepočítá, aby hash seděl — bez toho by korpus spadl na `MANIFEST_MISMATCH`
 * a test by měřil úplně jinou vadu. Hash se počítá **přesně tak, jak ho počítá
 * `readFrozen()`**: sha256 nad textem s LF.
 *
 * Proč kopie a ne mock `emitPatch`: mock by tu hodnotu vymyslel, a fixtura,
 * která vyrábí jiný svět než provoz, projde i nad vadným kódem. Takhle jede
 * routa celou svou skutečnou cestou — `frozenPrompt()` doopravdy ověří, že to
 * id v korpusu **je**, a `verifiedRecord()` doopravdy nenajde odpověď. Zmrazená
 * sada se přitom nedotkne: sahá se na kopii přes `process.cwd()`.
 */
function corpusWithHoles(missing: readonly string[]): Doors {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-holes-'));
  temporary.push(dir);
  const frozen = join(dir, 'evals', 'frozen');
  cpSync('evals/frozen', frozen, { recursive: true });

  const file = join(frozen, 'responses', 'index.jsonl');
  const kept = readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .filter((line) => {
      const record = JSON.parse(line) as FrozenResponse;
      return !(record.branch === 'edit' && missing.includes(record.forPrompt));
    });
  const text = `${kept.join('\n')}\n`;
  writeFileSync(file, text);

  const lock = join(frozen, 'MANIFEST.lock');
  const manifest = JSON.parse(readFileSync(lock, 'utf8')) as { files: Record<string, string> };
  manifest.files['responses/index.jsonl'] = createHash('sha256')
    .update(Buffer.from(text, 'utf8'))
    .digest('hex');
  writeFileSync(lock, JSON.stringify(manifest, null, 2));

  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const log: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    log.push(String(line));
  });
  vi.resetModules();
  return { dir, log };
}

/**
 * **Dva důvody, jedny dveře, tentýž 404 — a přesto jiný stav.**
 *
 * Nález kontrolní revize 1. 9. 2026: `cdf2c06` poslal oba důvody na
 * `logRateLimited`, protože oba končí jako `UNKNOWN_PAIR`. Jenže
 * `NO_FROZEN_RESPONSE` si na těchhle dveřích volající vybrat neumí —
 * `frozenPrompt()` neznámé id odmítne dřív jako `UNKNOWN_PROMPT` — takže sem
 * dojde jen tehdy, když v korpusu chybí odpověď. `logRateLimited` přitom
 * klíčuje `(dveře, kód)`, takže několik různých děr sdílí jedno počítadlo
 * a druhá i třetí mlčí navždy.
 */
describe('a hole in the corpus is told apart from a caller mistake at the edit door', () => {
  it('two holes give two lines, fifty requests on one give one, and the mistake keeps its own', async () => {
    // E01 zůstane celý — je to `editRecord.forPrompt`, na kterém se dole soudí
    // omyl volajícího. Díry jsou proto na dvou jiných.
    const doors = corpusWithHoles(['E02', 'E03']);
    const { POST } = await import('../../app/api/edit/route');

    const ask = (promptId: string): Request =>
      post('http://127.0.0.1/api/edit', {
        promptId,
        worldDoc: BASE_DOC,
        baseRevision: { sim: BASE_DOC.simRevision, look: BASE_DOC.lookRevision },
      });

    expect((await POST(ask('E02'))).status, 'fixtura nedělá díru v korpusu').toBe(404);
    expect((await POST(ask('E03'))).status).toBe(404);
    for (let attempt = 0; attempt < 50; attempt += 1) await POST(ask('E02'));

    const holes = doors.log.filter((line) => line.includes('NO_FROZEN_RESPONSE'));
    expect(holes, 'druhá díra v korpusu se neohlásila — sdílené počítadlo').toHaveLength(2);
    expect(holes[0]).toContain('E02');
    expect(holes[1]).toContain('E03');
    expect(
      holes.filter((line) => line.includes('E02')),
      'lepivá mez neplatí — padesát požadavků na jednu díru napsalo víc řádků',
    ).toHaveLength(1);

    // A vedle toho omyl volajícího na **zdravém** záznamu. Kdyby oba důvody
    // sdílely jedno počítadlo, byl by tenhle až druhý výskyt, tedy žádný řádek.
    expect((await POST(ask(editRecord.forPrompt))).status).toBe(404);
    const mistakes = doors.log.filter((line) => line.includes('BASE_WORLD_MISMATCH'));
    expect(mistakes, 'omyl volajícího se ztratil pod počítadlem děr').toHaveLength(1);
    expect(mistakes[0]).toContain('(occurrence 1)');
  });
});

/**
 * **Klíč lepivého zápisu je `detail`, ne kód** — a tohle je jediné místo, kde
 * se to dá soudit přímo.
 *
 * Nezávislá revize to změřila jako mrtvou vlastnost: mutace `has(detail)` →
 * `has(code)` nechala celou tehdejší sadu zelenou, přestože pod tím mutantem
 * **druhý a třetí rozbitý záznam mlčí napořád**. Šlo to jen proto, že funkce
 * byla soukromá uvnitř routy a nikdo ji nevolal přímo. Od 1. 9. 2026 bydlí
 * v `public-faults.ts`, takže tenhle test existovat může.
 */
describe('the sticky bound keys on the fault, not on its code', () => {
  async function sticky(): Promise<{
    readonly log: string[];
    readonly write: typeof import('../public-faults').logStickyFault;
  }> {
    const log = captureLog();
    vi.resetModules();
    return { log, write: (await import('../public-faults')).logStickyFault };
  }

  it('two broken records give two lines, a thousand requests on one give one', async () => {
    const { log, write } = await sticky();

    write('generate', 'req-1', 'NO_FROZEN_ANSWER', 'no frozen create response for C01');
    // Týž kód, týž vchod, **jiný záznam**. Kdyby se klíčovalo kódem, tenhle
    // řádek zmizí — a s ním každá další díra ve zmrazené sadě.
    write('generate', 'req-2', 'NO_FROZEN_ANSWER', 'no frozen create response for C02');
    // A tisíc požadavků na ten první pořád jeden řádek.
    for (let attempt = 0; attempt < 1000; attempt += 1)
      write('generate', `flood-${attempt}`, 'NO_FROZEN_ANSWER', 'no frozen create response for C01');

    expect(log).toHaveLength(2);
    expect(log[0]).toContain('req-1');
    expect(log[1]).toContain('req-2');
    expect(log.join('\n'), 'bound neplatí — opakování téže vady se zapsalo znovu').not.toContain(
      'flood-',
    );
  });

  /**
   * **Opravená vada, která se vrátí, není táž událost.**
   *
   * Nález nezávislé revize 1. 9. 2026 (`VERDICT: routed`, LOW): „jednou za
   * proces" mlčí i po opravě, takže operátor, který rozbitý zmrazený záznam
   * spraví a ten se v témž procesu rozejde znovu se stejným textem, nedostane
   * **nic** — a mlčící kanál vypadá v logu přesně jako zdravý server.
   *
   * Ten bound se přitom rušit nesmí: tisíc požadavků na jeden rozbitý záznam
   * je pořád jeden řádek. Obojí se proto soudí v jednom testu, protože každá
   * půlka bez té druhé je vada.
   */
  it('names a fault again once it was repaired and came back', async () => {
    const { log, write } = await sticky();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const broken = 'responses/index.jsonl is not readable';
    write('emit', 'req-1', 'CORPUS_UNREADABLE', broken);
    for (let attempt = 0; attempt < 1000; attempt += 1)
      write('emit', `flood-${attempt}`, 'CORPUS_UNREADABLE', broken);
    expect(log, 'bound neplatí — opakování téže vady se zapsalo znovu').toHaveLength(1);

    // Těsně pod hranou okna pořád ticho. Tenhle zápis navíc soudí, že okno
    // běží od posledního ZÁPISU, ne od posledního výskytu: kdyby ho posouval
    // každý potlačený požadavek, trvalá porucha pod trvalým provozem by se
    // nepřipomněla nikdy — táž vada, jen naruby.
    now += STICKY_WINDOW_MS - 1;
    write('emit', 'inside-window', 'CORPUS_UNREADABLE', broken);
    expect(log, 'lepivá mez se rozpadla na řádek za požadavek').toHaveLength(1);

    // Oprava, návrat — a operátor se to dozví.
    now += 1;
    write('emit', 'came-back', 'CORPUS_UNREADABLE', broken);
    expect(log, 'vada se vrátila a operátor se to nedozvěděl').toHaveLength(2);
    expect(log[1]).toContain('came-back');
    expect(log[1]).toContain(broken);
  });

  it('and on the door, so one broken corpus is still named by each door that hits it', async () => {
    const { log, write } = await sticky();

    write('emit', 'req-1', 'CORPUS_UNREADABLE', 'responses/index.jsonl is not readable');
    // Táž vada, jiné dveře. Řádek jmenuje **které dveře mluví**, takže sdílet
    // klíč napříč vchody by tu informaci zahodilo hned u druhého z nich.
    write('edit', 'req-2', 'CORPUS_UNREADABLE', 'responses/index.jsonl is not readable');

    expect(log).toHaveLength(2);
    expect(log[0]).toContain('[emit]');
    expect(log[1]).toContain('[edit]');
  });
});

/* ------------------------------------------------------------------ *
 * Druhá vada týchž dveří: tělo, které se rozpadne uprostřed čtení.
 * ------------------------------------------------------------------ */

/**
 * Požadavek, jehož tělo se **odmítne** místo aby dorazilo.
 *
 * `readBody()` vrací svoje meze — velikost i čas — jako hodnotu, takže vypadá,
 * že vyhodit nemá co. Samotné `reader.read()` se ale odmítnout může: přerušené
 * spojení, vadná komprese. Dokud bylo volání mimo `try`, proletělo to odmítnutí
 * z handleru ven a odpověď složil Next.js — pětistovka **bez `requestId`**,
 * tedy jediný požadavek v provozu, který se nedá spárovat s řádkem v logu.
 */
function brokenBody(url: string): Request {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error('the connection went away mid-body'));
    },
  });
  return new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit & {
    duplex: 'half';
  });
}

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

describe('a body that breaks mid-read answers with a correlated 400 at every door', () => {
  /**
   * Všechny čtvery dveře v **jednom** procesu, protože se tím soudí i to druhé:
   * bound na zápis je klíčovaný dvojicí (dveře, kód), takže čtvery dveře dají
   * čtyři řádky. Jeden společný klíč by první dveře nechal zapsat a tři zbylé
   * umlčel — a ta ztráta by se na jedněch dveřích poznat nedala.
   */
  it('and writes the operator exactly one line per door', async () => {
    const log = captureLog();

    const doors: { readonly name: string; readonly url: string; readonly POST: (r: Request) => Promise<Response> }[] = [
      { name: 'generate', url: 'http://127.0.0.1/api/generate', POST: (await import('../../app/api/generate/route')).POST },
      { name: 'emit', url: 'http://127.0.0.1/api/emit', POST: (await import('../../app/api/emit/route')).POST },
      { name: 'emit/stream', url: 'http://127.0.0.1/api/emit/stream', POST: (await import('../../app/api/emit/stream/route')).POST },
      { name: 'edit', url: 'http://127.0.0.1/api/edit', POST: (await import('../../app/api/edit/route')).POST },
    ];

    for (const door of doors) {
      const response = await door.POST(brokenBody(door.url));
      const sent = (await response.json()) as { requestId?: string; error?: { code?: string } };

      expect(response.status, `${door.name}: odpověď složil framework, ne routa`).toBe(400);
      expect(sent.error?.code, `${door.name}: chybí kód důvodu`).toBe('BODY_UNREADABLE');
      expect(typeof sent.requestId, `${door.name}: pětistovka bez korelačního ID`).toBe('string');
      expect(
        log.join('\n'),
        `${door.name}: řádek v logu nejde spárovat s odpovědí`,
      ).toContain(String(sent.requestId));
    }

    expect(
      log.filter((line) => line.includes('BODY_UNREADABLE')),
      'čtvery dveře nenapsaly čtyři řádky — bound je klíčovaný moc hrubě',
    ).toHaveLength(4);
  });

  /**
   * **Bound, ne opatrnost.** Žádná z těch rout nechce přihlášení a přerušit
   * vlastní spojení umí volající kolikrát chce, takže řádek na požadavek je
   * log, který si kdokoli natáhne donekonečna. Táž vada jako u lepivého
   * odmítnutí stropem v `/api/generate`, jen jiným vchodem.
   *
   * **Dvacet požadavků = dva řádky, ne jeden.** Vydává se 1. a 10. výskyt;
   * mlčení po prvním by šlo koupit jedním požadavkem hned po nasazení a
   * skutečná porucha ve dvanácté hodině by pak neměla čím se ozvat.
   *
   * Smyčka jde přes **všechny čtvery** dveře, které tím boundem jdou. Dokud
   * běžela jen přes `emit`, nic nepřipínalo, že ty ostatní bound vůbec mají —
   * a `/api/generate` ho doopravdy neměl.
   */
  it('and slows down to milestones, however many arrive', async () => {
    const log = captureLog();

    const doors = [
      { name: 'generate', url: 'http://127.0.0.1/api/generate', POST: (await import('../../app/api/generate/route')).POST },
      { name: 'emit', url: 'http://127.0.0.1/api/emit', POST: (await import('../../app/api/emit/route')).POST },
      { name: 'emit/stream', url: 'http://127.0.0.1/api/emit/stream', POST: (await import('../../app/api/emit/stream/route')).POST },
      { name: 'edit', url: 'http://127.0.0.1/api/edit', POST: (await import('../../app/api/edit/route')).POST },
    ];

    for (const door of doors)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await door.POST(brokenBody(door.url));
        expect(response.status).toBe(400);
      }

    for (const door of doors)
      expect(
        log.filter((line) => line.startsWith(`[${door.name}] `) && line.includes('BODY_UNREADABLE')),
        `${door.name}: 20 přerušených spojení nedalo dva řádky`,
      ).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Vlastnosti sdíleného modulu.
 * ------------------------------------------------------------------ */

describe('the operator log is rate-limited, never silenced for good', () => {
  /**
   * Měří se přímo na funkci, ne přes routu: přes routu se nedá dojet ke stému
   * výskytu v rozumném čase a klíč by se soudil jen nepřímo.
   */
  async function limiter(): Promise<{ readonly log: string[]; readonly write: typeof import('../public-faults').logRateLimited }> {
    const log: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      log.push(String(line));
    });
    vi.resetModules();
    return { log, write: (await import('../public-faults')).logRateLimited };
  }

  it('writes the 1st, 10th and 100th of the same fault and nothing between', async () => {
    const { log, write } = await limiter();

    for (let attempt = 0; attempt < 250; attempt += 1)
      write('emit', `req-${attempt}`, 'BODY_UNREADABLE', 'the body ended mid-read');

    // 250 požadavků, tři řádky. Milion by dal sedm — logaritmus provozu.
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('(occurrence 1)');
    expect(log[1]).toContain('(occurrence 10)');
    expect(log[2]).toContain('(occurrence 100)');
    // Číslo výskytu je v textu schválně: bez něj vypadá desátý řádek jako
    // první a operátor záplavu nepozná.
    expect(log[1]).toContain('the body ended mid-read');
  });

  /**
   * **Ticho vyprší.** Ne „nedá se koupit" — to by tvrdilo víc, než kód umí, a
   * nezávislá revize přesně tenhle rozdíl 1. 9. 2026 změřila: 100 požadavků na
   * začátku každého okna (400 req/h) drží klíč umlčený natrvalo. Co je tady
   * doložené, je že jedna dávka umlčí kanál nejvýš na jedno okno.
   *
   * Hodiny se podvrhují `Date.now()`, protože přesně to okno čte. Na replay
   * cestě by to byl zákaz z `CLAUDE.md`; tady je to operátorův log serveru.
   */
  it('lets a bought silence expire with the window instead of standing for the process', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    // Předplacené umlčení: sto laciných selhání, tři řádky (1., 10., 100.).
    for (let attempt = 0; attempt < 100; attempt += 1)
      write('emit', `paid-${attempt}`, 'BODY_UNREADABLE', 'the body ended mid-read');
    expect(log).toHaveLength(3);

    // Táž příčina těsně pod hranou okna pořád mlčí — jinak by mez neexistovala.
    // Tenhle zápis zároveň soudí, že se okno kotví na svém PRVNÍM výskytu:
    // kdyby ho posouval každý další, útočník by ho držel otevřený napořád.
    now += RATE_LIMIT_WINDOW_MS - 1;
    write('emit', 'inside-window', 'BODY_UNREADABLE', 'the body ended mid-read');
    expect(log, 'okno neplatí — mez se rozpadla na řádek na požadavek').toHaveLength(3);

    // A hned za ní se táž příčina ohlásí PRVNÍM řádkem, ne stým prvním.
    now += 1;
    write('emit', 'after-window', 'BODY_UNREADABLE', 'the body ended mid-read');
    expect(log, 'ticho nevypršelo — počítadlo je zase na celý proces').toHaveLength(4);
    expect(log[3]).toContain('after-window');
    expect(log[3]).toContain('(occurrence 1)');
  });

  /**
   * **Příčina, kterou operátor ještě neviděl, se vydá i uvnitř koupeného ticha.**
   *
   * Tohle je to, co z vypršení dělá obranu i během okna: útočník drží počítadlo
   * nahoře **jednou** příčinou („aborted"), ale rozbitá proxy nese jinou hlášku,
   * takže projde hned. Bez tohohle pravidla dostal operátor v osmihodinovém
   * měření revize 96 řádků útočníka a nula o poruše, která padla 28 768krát.
   */
  it('always names a cause it has not seen in this window, even while another is flooding', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    for (let attempt = 0; attempt < 100; attempt += 1)
      write('emit', `paid-${attempt}`, 'BODY_UNREADABLE', 'aborted');
    expect(log).toHaveLength(3);

    // Uprostřed okna, dávno za posledním milníkem, a přece slyšet.
    now += 60_000;
    write('emit', 'proxy-1', 'BODY_UNREADABLE', 'Premature close');
    expect(log, 'nová příčina se ztratila pod cizím počítadlem').toHaveLength(4);
    expect(log[3]).toContain('proxy-1');
    expect(log[3]).toContain('Premature close');

    // Ale opakování téže příčiny už ne — jinak by pravidlo mez zrušilo.
    write('emit', 'proxy-2', 'BODY_UNREADABLE', 'Premature close');
    expect(log, 'opakovaná příčina obchází mez').toHaveLength(4);
  });

  /**
   * **A ten rozpočet je omezený, ale patří oknu** — obojí v jednom testu,
   * protože každá půlka bez té druhé je vada:
   *
   * - bez stropu by stačilo měnit hlášku a pravidlo o nové příčině by z meze
   *   udělalo řádek na požadavek;
   * - bez vrácení s oknem by osm příčin umlčelo devátou **napořád**, tedy táž
   *   předplacená tichost o patro níž. Mutace, která množinu příčin ponese
   *   přes hranu okna, musí položit druhou půlku — a nesmí položit první.
   */
  it('spends at most a fixed budget of causes per window, and gets it back with the window', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const causes = MAX_DETAILS_PER_WINDOW * 2 + 4;
    for (let attempt = 0; attempt < causes; attempt += 1)
      write('emit', `req-${attempt}`, 'BODY_UNREADABLE', `cause ${attempt}`);

    // Osm příčin (0..7) plus desátý výskyt jako milník — devět řádků z dvaceti.
    expect(log, `${causes} různých příčin nesmí dát řádek na požadavek`).toHaveLength(
      MAX_DETAILS_PER_WINDOW + 1,
    );
    expect(log.join('\n')).toContain('cause 7');
    expect(log.join('\n'), 'rozpočet příčin neplatí').not.toContain('cause 19');

    // Nové okno. První zápis je milník, takže se vydá tak či tak — je tu jen
    // proto, aby ten druhý padl na výskyt, který milník NENÍ, a rozhodovalo
    // o něm výhradně to, jestli se rozpočet příčin vrátil.
    now += RATE_LIMIT_WINDOW_MS;
    write('emit', 'fresh-1', 'BODY_UNREADABLE', 'cause 0');
    const spent = log.length;
    write('emit', 'fresh-2', 'BODY_UNREADABLE', 'a cause never seen before');

    expect(log, 'rozpočet příčin se s oknem nevrátil').toHaveLength(spent + 1);
    expect(log[log.length - 1]).toContain('fresh-2');
  });

  it('keeps each key on its own window, so one noisy door cannot mute another', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    write('emit', 'req-1', 'BODY_UNREADABLE', 'first');
    // Druhý klíč začíná své okno až tady, takže o hranu toho prvního nezavadí.
    now += RATE_LIMIT_WINDOW_MS - 1;
    write('edit', 'req-2', 'BODY_UNREADABLE', 'second');
    now += 2;
    // První klíč je za hranou (nové okno), druhý pořád ve svém. Obojí opakuje
    // příčinu, kterou ten klíč už v tomhle okně vydal — jinak by o tom, co se
    // vydá, rozhodlo pravidlo o nové příčině a ne okno.
    write('emit', 'req-3', 'BODY_UNREADABLE', 'first');
    write('edit', 'req-4', 'BODY_UNREADABLE', 'second');

    expect(log).toHaveLength(3);
    expect(log.join('\n')).toContain('req-3');
    expect(log.join('\n')).not.toContain('req-4');
  });

  it('keys on the code as well as the door, so a second fault is never swallowed', async () => {
    const { log, write } = await limiter();

    write('emit', 'req-1', 'BODY_UNREADABLE', 'first');
    // Jiný kód týchž dveří: kdyby se klíčovalo jen podle dveří, tenhle řádek
    // zmizí a s ním celá druhá třída poruch.
    write('emit', 'req-2', 'CORPUS_UNREADABLE', 'second');
    // A jiné dveře s týmž kódem, ze stejného důvodu opačným směrem.
    write('edit', 'req-3', 'BODY_UNREADABLE', 'third');
    // Opakování prvního klíče **s touž příčinou** se už nevydá — bound platí.
    // (Jiná příčina by se vydala schválně; to soudí test o rozpočtu příčin.)
    write('emit', 'req-4', 'BODY_UNREADABLE', 'first');

    expect(log).toHaveLength(3);
    expect(log.join('\n')).toContain('req-1');
    expect(log.join('\n')).toContain('req-2');
    expect(log.join('\n')).toContain('req-3');
    expect(log.join('\n')).not.toContain('req-4');
  });
});

describe('the shared table is the only thing four doors are allowed to say', () => {
  /**
   * `Record<ClientReason, string>` hlídá **úplnost** přes `tsc`. Tenhle test
   * hlídá to druhé: že v žádném z těch textů není nic, kvůli čemu tabulka
   * vznikla — číslo, hash ani cesta.
   */
  it('names what happened, never where or with what value', () => {
    const texts = Object.values(PUBLIC_CORPUS_FAULT);
    expect(texts.length).toBeGreaterThanOrEqual(6);

    for (const text of texts) {
      expect(text, `veřejný text nese číslo: „${text}"`).not.toMatch(/\d/);
      expect(text, `veřejný text nese cestu: „${text}"`).not.toMatch(/[/\\]/);
      expect(text).toBe(text.trim());
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('strips a password out of an address wherever it sits in the line', () => {
    expect(withoutCredentials('at https://operator:hunter2@upstream.invalid/v1')).toBe(
      'at https://<credentials>@upstream.invalid/v1',
    );
    expect(withoutCredentials('operator:hunter2@upstream.invalid')).toBe(
      '<credentials>@upstream.invalid',
    );
    expect(withoutCredentials('nothing to strip here')).toBe('nothing to strip here');
  });
});
