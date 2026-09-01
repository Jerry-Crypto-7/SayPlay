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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { peelEnvelope, sealSimHash, type WorldDoc } from '../../ir/worlddoc';
import { PUBLIC_CORPUS_FAULT, withoutCredentials } from '../public-faults';

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
 * Vlastnosti sdíleného modulu.
 * ------------------------------------------------------------------ */

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
