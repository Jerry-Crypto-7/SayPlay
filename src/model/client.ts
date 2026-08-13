/**
 * Modelový klient — v Phase 3 **výhradně režim záznamu**.
 *
 * Povolený double na hranici `route:POST /api/emit` je podle AC T13 jediný:
 * syntetická odpověď z `evals/frozen/responses/`, jejíž `sha256` sedí na
 * `MANIFEST.lock`. Odpověď vzniklá mimo zmrazený manifest je diskvalifikovaná —
 * a „diskvalifikovaná" tu znamená, že ji tenhle soubor odmítne vydat, ne že se
 * na to někdo spolehne v testu.
 *
 * Kontroluje se **dvakrát, dvěma nezávislými hashi**, protože každý chytá jinou
 * podvodnou cestu:
 *
 * 1. **hash souboru proti `MANIFEST.lock`** — zachytí přepsaný, doplněný nebo
 *    odebraný záznam. Bez něj by stačilo do souboru dopsat řádek s vlastní
 *    odpovědí a per-record hash by na ni seděl, protože by se počítal z ní samé.
 * 2. **per-record `sha256` nad `JSON.stringify(record.body)`** — `MANIFEST.lock`
 *    to předepisuje doslova (`responseBodyHashRule`) a zachytí tělo vyměněné za
 *    jiné uvnitř jinak nedotčeného souboru.
 *
 * **Ta první kontrola platí pro KAŽDÝ zmrazený soubor, který tahle cesta čte,
 * ne jen pro odpovědi.** `MANIFEST.lock` sám říká, že musí krýt každý soubor, a
 * `protocol.v1.json` i `prompts.v1.jsonl` jsou přesně to, z čeho vzniká
 * zaznamenaný upstream požadavek — tedy artefakt, na který se AC T13 ptá.
 * Dokud se nekontrolovaly, stačilo přepsat text promptu: endpoint vrátil 200
 * s nezměněným zmrazeným světem, `upstream.user` nesl cizí text, a test to
 * neviděl, protože četl tentýž podvržený soubor.
 *
 * Ani jedna z nich nedokazuje, že soubor sedí na commitnutý strom — to hlídá
 * `evals/__tests__/frozen.test.ts`. Tady jde o to, aby produkční cesta nikdy
 * nevydala odpověď, kterou zmrazení nekryje.
 *
 * **Nečitelný korpus není verdikt.** Každé čtení je proto výsledek, ne výjimka:
 * spuštění z jiného adresáře je rozbité prostředí, ne vadná emise, a smí skončit
 * jedině strukturovanou odpovědí. Nezachycená výjimka by z něj udělala 500 —
 * přesně ten signál, který má endpoint vyhrazený pro spadlé potrubí a který by
 * měřicí běh v T17 nedokázal odlišit od vadného světa.
 *
 * **Hlavička `synthetic: true` není formalita.** Tyhle záznamy neříkají nic
 * o kvalitě modelu; prokazují správnost potrubí. Kvalitu měří až živý běh za
 * HALT bránou (T18). Klient proto hlavičku vyžaduje a propouští ji do
 * provenience, aby se výsledek nedal vydávat za měření modelu.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { peelEnvelope, simHashOf } from '../ir/worlddoc';
import type { Grammar, UpstreamRequest } from './prompt';

const FROZEN_DIR = join(process.cwd(), 'evals', 'frozen');
const RESPONSES_FILE = 'responses/index.jsonl';

export type ClientReason =
  /** Zmrazený soubor se rozešel s `MANIFEST.lock`. */
  | 'MANIFEST_MISMATCH'
  /** Soubor zmrazeného korpusu nejde přečíst — rozbité prostředí, ne emise. */
  | 'CORPUS_UNREADABLE'
  /** Pro tenhle prompt zmrazená odpověď neexistuje. */
  | 'NO_FROZEN_RESPONSE'
  /** Tělo se rozešlo s vlastním `sha256`, nebo mu chybí hlavička. */
  | 'RESPONSE_TAMPERED'
  /** Editační záznam existuje, ale je vázaný na jiný svět, než jaký přišel. */
  | 'BASE_WORLD_MISMATCH';

export interface ClientFailure {
  readonly ok: false;
  readonly reason: ClientReason;
  readonly detail: string;
}

/** Odkud odpověď je. Jde do odpovědi endpointu, aby byl běh auditovatelný. */
export interface Provenance {
  readonly source: 'frozen-manifest';
  readonly synthetic: true;
  readonly file: string;
  readonly bodySha256: string;
  readonly declaredVerdict: string;
}

export interface ClientSuccess {
  readonly ok: true;
  readonly body: unknown;
  readonly request: UpstreamRequest;
  readonly provenance: Provenance;
}

export type ClientResult = ClientSuccess | ClientFailure;

type Read<T> = { readonly ok: true; readonly value: T } | ClientFailure;

/**
 * Přečte zmrazený soubor a **ověří jeho hash proti `MANIFEST.lock`**.
 *
 * `MANIFEST.lock` normalizuje CRLF na LF **před** hashováním. Bez toho by hash
 * téhož souboru závisel na stroji, na kterém se repo checkoutovalo.
 */
function readFrozen(relativePath: string): Read<string> {
  let manifest: { files?: Record<string, string> };
  let text: string;
  try {
    manifest = JSON.parse(readFileSync(join(FROZEN_DIR, 'MANIFEST.lock'), 'utf8')) as {
      files?: Record<string, string>;
    };
    text = readFileSync(join(FROZEN_DIR, relativePath)).toString('utf8').replace(/\r\n/g, '\n');
  } catch (thrown) {
    return {
      ok: false,
      reason: 'CORPUS_UNREADABLE',
      detail: `${relativePath} is not readable under ${FROZEN_DIR}: ${(thrown as Error).message}`,
    };
  }

  const expected = manifest.files?.[relativePath];
  const actual = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  if (expected !== actual)
    return {
      ok: false,
      reason: 'MANIFEST_MISMATCH',
      detail: `${relativePath} hashes to ${actual}, MANIFEST.lock says ${String(expected)}`,
    };

  return { ok: true, value: text };
}

function readJsonl(relativePath: string): Read<Record<string, unknown>[]> {
  const file = readFrozen(relativePath);
  if (!file.ok) return file;
  try {
    return {
      ok: true,
      value: file.value
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } catch (thrown) {
    // Hash sedí, takže tohle je vada zmrazeného souboru samotného, ne podvrh.
    return { ok: false, reason: 'CORPUS_UNREADABLE', detail: `${relativePath}: ${(thrown as Error).message}` };
  }
}

/** Slovník ze zmrazeného protokolu — prompt si ho nesmí opsat. */
export function frozenGrammar(): Read<Grammar> {
  const file = readFrozen('protocol.v1.json');
  if (!file.ok) return file;
  let protocol: {
    grammar: { surfaceEvents: string[]; conditions: string[]; actions: string[] };
    worldDoc: { sim: { fields: string[] }; look: { fields: string[] } };
  };
  try {
    protocol = JSON.parse(file.value) as typeof protocol;
  } catch (thrown) {
    return { ok: false, reason: 'CORPUS_UNREADABLE', detail: `protocol.v1.json: ${(thrown as Error).message}` };
  }
  return {
    ok: true,
    value: {
      surfaceEvents: protocol.grammar.surfaceEvents,
      conditions: protocol.grammar.conditions,
      actions: protocol.grammar.actions,
      simFields: protocol.worldDoc.sim.fields,
      lookFields: protocol.worldDoc.look.fields,
    },
  };
}

export interface FrozenPrompt {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
}

/**
 * Zmrazený prompt podle id.
 *
 * `null` znamená **neznámé id** (endpoint z toho dělá 404). Nečitelný nebo
 * podvržený korpus je oproti tomu `ClientFailure` — jiná věc, jiná odpověď.
 */
export function frozenPrompt(id: string): Read<FrozenPrompt | null> {
  const records = readJsonl('prompts.v1.jsonl');
  if (!records.ok) return records;
  const found = records.value.find((record) => record.id === id);
  if (found === undefined || typeof found.prompt !== 'string' || typeof found.kind !== 'string')
    return { ok: true, value: null };
  return { ok: true, value: { id, kind: found.kind, prompt: found.prompt } };
}

/**
 * Vydá odpověď poskytovatele pro zmrazený prompt.
 *
 * `request` se **nepoužije k ničemu jinému než k záznamu** — v režimu záznamu
 * odpověď na jeho obsahu nezávisí. Je to tak schválně: až T18 nahradí tělo
 * funkce skutečným voláním, tvar téhle hranice se nezmění a záznam bude pořád
 * ten, který se doopravdy odeslal.
 */
export function emitWorld(promptId: string, request: UpstreamRequest): ClientResult {
  const record = verifiedRecord(promptId, 'create');
  if (!record.ok) return record;

  return {
    ok: true,
    body: record.value.entry.body,
    request,
    provenance: provenanceOf(record.value),
  };
}

interface VerifiedRecord {
  readonly entry: Record<string, unknown>;
  readonly bodySha256: string;
}

/**
 * Zmrazený záznam pro dvojici (prompt, větev), ověřený **oběma** hashi.
 *
 * Sdílené mezi tvorbou a editací schválně: obě větve mají tutéž záruku a druhá
 * kopie kontrol je přesně ta třída vady, kterou brána nad T13 našla u čtení
 * promptů — jedna cesta hash ověřovala, druhá ne, a rozdíl neuhlídal nikdo.
 */
function verifiedRecord(promptId: string, branch: 'create' | 'edit'): Read<VerifiedRecord> {
  const records = readJsonl(RESPONSES_FILE);
  if (!records.ok) return records;

  const entry = records.value.find((item) => item.forPrompt === promptId && item.branch === branch);
  if (entry === undefined)
    return { ok: false, reason: 'NO_FROZEN_RESPONSE', detail: `no frozen ${branch} response for ${promptId}` };

  if (entry.synthetic !== true)
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `response for ${promptId} does not declare synthetic: true`,
    };

  const bodySha256 = createHash('sha256').update(JSON.stringify(entry.body)).digest('hex');
  if (bodySha256 !== entry.sha256)
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `body for ${promptId} hashes to ${bodySha256}, the record claims ${String(entry.sha256)}`,
    };

  return { ok: true, value: { entry, bodySha256 } };
}

function provenanceOf(record: VerifiedRecord): Provenance {
  return {
    source: 'frozen-manifest',
    synthetic: true,
    file: RESPONSES_FILE,
    bodySha256: record.bodySha256,
    declaredVerdict: String(record.entry.expectedVerdict),
  };
}

export interface PatchSuccess {
  readonly ok: true;
  /** Tělo patche tak, jak přišlo — pole operací se ověřuje až router. */
  readonly body: unknown;
  /** Štítek od modelu. **Zaznamenává se, nerozhoduje** (§7). */
  readonly label: string | undefined;
  /** Svět, proti kterému byl záznam autorován. */
  readonly baseWorld: string;
  readonly request: UpstreamRequest;
  readonly provenance: Provenance;
}

export type PatchResult = PatchSuccess | ClientFailure;

/**
 * Vydá patch poskytovatele pro zmrazený **editační** prompt.
 *
 * `simHash` není dekorace: Oracle úlohy T14 povoluje jako double *„upstream jen
 * záznamem vázaným na dvojici (svět, prompt)"*. Zmrazený patch je autorovaný
 * proti konkrétnímu základnímu světu a proti jinému světu neměří editaci, ale
 * náhodu — cesty buď neexistují, nebo trefí něco jiného, než na co mířily.
 * Vazba se proto ověřuje **hashem `sim` části** základního světa, ne jménem:
 * jméno by sedělo i na svět, který si volající přepsal cestou sem.
 *
 * `look` do vazby nevstupuje. Leží mimo hash schválně (§13.1) a patch vzhledu se
 * proti němu vydává stejně legálně jako proti výchozímu.
 */
export function emitPatch(promptId: string, request: UpstreamRequest, simHash: string): PatchResult {
  const record = verifiedRecord(promptId, 'edit');
  if (!record.ok) return record;

  const baseWorld = record.value.entry.baseWorld;
  if (typeof baseWorld !== 'string')
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `the edit response for ${promptId} names no baseWorld, so it is bound to no world at all`,
    };

  const expected = frozenBaseSimHash(baseWorld);
  if (!expected.ok) return expected;
  if (expected.value !== simHash)
    return {
      ok: false,
      reason: 'BASE_WORLD_MISMATCH',
      detail: `${promptId} was authored against ${baseWorld} (simHash ${expected.value}); the submitted world hashes to ${simHash}`,
    };

  return {
    ok: true,
    body: record.value.entry.body,
    label: typeof record.value.entry.modelLabel === 'string' ? record.value.entry.modelLabel : undefined,
    baseWorld,
    request,
    provenance: provenanceOf(record.value),
  };
}

/**
 * `simHash` základního světa, spočítaný z jeho zmrazené create emise.
 *
 * Počítá se **z oloupaného** těla: anotace obálky (`simOutcome` a spol.) jedou
 * vedle dokumentu a do hashe nikdy nevstupují — tak, jak je pečetí `/api/emit`.
 * Kdyby se hashovalo syrové tělo, čtyři anotované create světy by měly jiný hash
 * tady než tam a vazba by je odmítla, přestože se nic nezměnilo.
 */
function frozenBaseSimHash(baseWorld: string): Read<string> {
  const record = verifiedRecord(baseWorld, 'create');
  if (!record.ok) return record;

  const peeled = peelEnvelope(record.value.entry.body);
  if (peeled === null || !Object.hasOwn(peeled.document, 'sim'))
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `the frozen create response for ${baseWorld} carries no sim part to bind against`,
    };

  return { ok: true, value: simHashOf(peeled.document as { sim: unknown }) };
}
