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

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonical, peelEnvelope } from '../ir/worlddoc';
import type { Grammar, UpstreamRequest } from './prompt';

const FROZEN_DIR = join(process.cwd(), 'evals', 'frozen');
const RESPONSES_FILE = 'responses/index.jsonl';

/**
 * Vada **celého zmrazeného souboru**, ne jednoho záznamu v něm.
 *
 * Obě znamenají rozbité prostředí: server v tomhle stavu neobsluhuje nikoho.
 */
export type CorpusReason =
  /** Zmrazený soubor se rozešel s `MANIFEST.lock`. */
  | 'MANIFEST_MISMATCH'
  /** Soubor zmrazeného korpusu nejde přečíst — rozbité prostředí, ne emise. */
  | 'CORPUS_UNREADABLE';

/**
 * **Přesně ty důvody, které umí vyrobit `emitWorld()`** — nic víc.
 *
 * Ta úzkost je celý smysl typu a je naměřená: dokud `emitWorld()` deklaroval
 * celý `ClientReason`, musela tabulka `BRANCH_FAULT` (`src/server/mock`)
 * rozhodnout i o dvou editačních důvodech, které jí nikdy nemohly přijít — a
 * **rozhodla je opačně, než jak to stojí na obou místech, která je definují**
 * (nález nezávislé revize 1. 9. 2026). `BASE_WORLD_MISSING` tam mířil na
 * `NO_FROZEN_ANSWER`, tedy na 404, přestože komentář o pár řádků níž říká, že
 * schovat ho pod chybějící odpověď znamená vydat rozbité prostředí jako 404,
 * a `/api/edit` ho z větve 404 schválně vyjímá a vrací 503.
 *
 * Rozhodnutí „předem" o důvodu, který se dnes nedá vyrobit, není záruka: je to
 * odpověď na otázku, kterou nikdo nepoložil, a nemá ji kdo zkontrolovat. Když
 * se množina jednou rozšíří, má **spadnout `tsc`** a rozhodnout to člověk,
 * který u toho bude mít kontext.
 */
export type EmitReason = CorpusReason | 'NO_FROZEN_RESPONSE' | 'RESPONSE_TAMPERED';

export type ClientReason =
  | EmitReason
  /** Editační záznam existuje, ale je vázaný na jiný svět, než jaký přišel. */
  | 'BASE_WORLD_MISMATCH'
  /**
   * Editační záznam jmenuje základní svět, který ve zmrazené sadě není.
   *
   * Je to vada **korpusu**, ne dotazu, a proto vlastní důvod: kdyby se schovala
   * pod `NO_FROZEN_RESPONSE`, endpoint by rozbité prostředí vydal jako 404 nad
   * dvojicí — tedy jako naměřený výsledek něčeho, co se skórovat nesmí.
   */
  | 'BASE_WORLD_MISSING';

/**
 * Selhání klienta. Parametr `R` je **množina důvodů, které to konkrétní volání
 * umí vrátit** — bez něj je to celý `ClientReason`, tedy dnešní chování všude,
 * kde na užší množině nezáleží.
 */
export interface ClientFailure<R extends ClientReason = ClientReason> {
  readonly ok: false;
  readonly reason: R;
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

/** Výsledek `emitWorld()`. Užší než `ClientResult`, viz `EmitReason`. */
export type EmitResult = ClientSuccess | ClientFailure<EmitReason>;

type Read<T, R extends ClientReason = ClientReason> =
  | { readonly ok: true; readonly value: T }
  | ClientFailure<R>;

/**
 * Ověřené soubory, které už se v tomhle procesu jednou přečetly.
 *
 * **Cache smí existovat jen proto, že ten korpus je zmrazený.** Obsah je
 * zamčený hashem v `MANIFEST.lock`, takže „přečti znovu" nemůže dát jinou
 * odpověď — na rozdíl od ovládacího souboru stropu, který se schválně čte při
 * každém volání, aby operátor mohl za incidentu sáhnout na páku bez restartu.
 *
 * **Ukládá se jen úspěch.** Nečitelný korpus je vada stroje nebo nasazení a ta
 * se dá spravit; zapamatovaný neúspěch by z jednoho výpadku disku udělal stav,
 * ze kterého se instance nedostane jinak než restartem. Neúspěšná cesta navíc
 * spadne na prvním `readFileSync` a hash nepočítá, takže je levná i bez cache.
 *
 * **Žije a umírá s modulem**, ne s procesem — a to je nosné pro sadu: klient si
 * `FROZEN_DIR` počítá z `process.cwd()` při importu, takže test, který podvrhne
 * pracovní adresář a načte modul znovu (`clientAt()` v `client.test.ts`),
 * dostane prázdnou cache. Kdyby cache modul přežila, druhý kořen by četl
 * z prvního a zelená by znamenala jen „poprvé se to přečetlo správně".
 */
const frozenFiles = new Map<string, string>();

/**
 * Přečte zmrazený soubor a **ověří jeho hash proti `MANIFEST.lock`**.
 *
 * `MANIFEST.lock` normalizuje CRLF na LF **před** hashováním. Bez toho by hash
 * téhož souboru závisel na stroji, na kterém se repo checkoutovalo.
 *
 * Čte **nejvýš jednou na cestu a proces** — viz `frozenFiles`. Bez toho stály
 * čtyři dveře, které `frozenGrammar()` volají, dva `readFileSync` a sha256 nad
 * 26 kB na **každém** požadavku, synchronně na smyčce událostí, a platilo se to
 * i na neplacené větvi a před stropem souběhu.
 */
function readFrozen(relativePath: string): Read<string, CorpusReason> {
  const cached = frozenFiles.get(relativePath);
  if (cached !== undefined) return { ok: true, value: cached };

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

  frozenFiles.set(relativePath, text);
  return { ok: true, value: text };
}

function readJsonl(relativePath: string): Read<Record<string, unknown>[], CorpusReason> {
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

/**
 * Hotový slovník. Druhá polovina téže cache: `frozenFiles` ušetří obě čtení
 * a hash, tohle navíc `JSON.parse` nad 26 kB, který se jinak platí znovu na
 * každém požadavku všech čtyř dveří.
 */
let frozenGrammarValue: Grammar | null = null;

/** Slovník ze zmrazeného protokolu — prompt si ho nesmí opsat. */
export function frozenGrammar(): Read<Grammar> {
  if (frozenGrammarValue !== null) return { ok: true, value: frozenGrammarValue };

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
  frozenGrammarValue = {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
  return { ok: true, value: frozenGrammarValue };
}

export interface FrozenPrompt {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
}

/**
 * Všechny zmrazené prompty, ověřené hashem proti `MANIFEST.lock`.
 *
 * Exportované kvůli offline větvi v `src/server/mock/`, která hledá podle textu
 * promptu, ne podle id. Vlastní čtení téhož souboru by tam znamenalo druhou
 * cestu ke korpusu — a přesně tahle třída vady tady jednou byla: jedna cesta
 * hash ověřovala, druhá ne, a rozdíl neuhlídal nikdo.
 */
export function frozenPrompts(): Read<FrozenPrompt[]> {
  const records = readJsonl('prompts.v1.jsonl');
  if (!records.ok) return records;
  return {
    ok: true,
    value: records.value.flatMap((record) =>
      typeof record.id === 'string' && typeof record.prompt === 'string' && typeof record.kind === 'string'
        ? [{ id: record.id, kind: record.kind, prompt: record.prompt }]
        : [],
    ),
  };
}

/**
 * Zmrazený prompt podle id.
 *
 * `null` znamená **neznámé id** (endpoint z toho dělá 404). Nečitelný nebo
 * podvržený korpus je oproti tomu `ClientFailure` — jiná věc, jiná odpověď.
 */
export function frozenPrompt(id: string): Read<FrozenPrompt | null> {
  const records = frozenPrompts();
  if (!records.ok) return records;
  return { ok: true, value: records.value.find((record) => record.id === id) ?? null };
}

/**
 * Vydá odpověď poskytovatele pro zmrazený prompt.
 *
 * `request` se **nepoužije k ničemu jinému než k záznamu** — v režimu záznamu
 * odpověď na jeho obsahu nezávisí. Je to tak schválně: až T18 nahradí tělo
 * funkce skutečným voláním, tvar téhle hranice se nezmění a záznam bude pořád
 * ten, který se doopravdy odeslal.
 */
export function emitWorld(promptId: string, request: UpstreamRequest): EmitResult {
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
function verifiedRecord(promptId: string, branch: 'create' | 'edit'): Read<VerifiedRecord, EmitReason> {
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
 * Otisk `sim` části pro **vazbu záznamu na svět** — SHA-256, ne `simHash`.
 *
 * `simHash` (FNV-1a-32, osm hex znaků) je identita pro replay a k tomu stačí:
 * dva různé stavy se stejným otiskem se v replayi projeví hned, protože se
 * porovnává celý průběh. Jako **autentizační vazba** je ale nepoužitelný —
 * 32 bitů se nehledá štěstím, hledá se výpočtem.
 *
 * Naměřeno bránou nad `f7e153c`, spuštěno end-to-end: ze zmrazeného `C02` stačí
 * změnit `state.timers.flood.durationTicks` (přesně ten list, který edituje
 * `E01`) a doplnit výplňový klíč do `witness`; protože `canonical` řadí klíče,
 * výplň se hashuje poslední a prefix se počítá jen jednou. **11,6 milionu
 * kandidátů, 215 ms** — a endpoint podvržený svět přijal jako `C02` s verdiktem
 * `CERTIFIED`. `migrateWorldDoc` proti tomu nepomůže: ověřuje, že `simHash`
 * sedí na svou vlastní `sim`, a to má padělatel plně ve své moci.
 *
 * Je to tatáž třída, jakou `CLAUDE.md` §5 vede u vynutitelnosti zmrazení — jen
 * uvnitř endpointu. Proto druhý, širší otisk počítaný **z obsahu**, nikdy
 * z hodnoty, kterou poslal volající.
 */
function simFingerprint(sim: unknown): string {
  return createHash('sha256').update(canonical(sim)).digest('hex');
}

/**
 * Vydá patch poskytovatele pro zmrazený **editační** prompt.
 *
 * `sim` není dekorace: Oracle úlohy T14 povoluje jako double *„upstream jen
 * záznamem vázaným na dvojici (svět, prompt)"*. Zmrazený patch je autorovaný
 * proti konkrétnímu základnímu světu a proti jinému světu neměří editaci, ale
 * náhodu — cesty buď neexistují, nebo trefí něco jiného, než na co mířily.
 * Vazba se proto ověřuje **otiskem obsahu** `sim` části základního světa, ne
 * jménem a ne `simHash`em: jméno by sedělo i na svět, který si volající přepsal
 * cestou sem, a `simHash` je forgeovatelný (viz `simFingerprint`).
 *
 * `look` do vazby nevstupuje. Leží mimo hash schválně (§13.1) a patch vzhledu se
 * proti němu vydává stejně legálně jako proti výchozímu.
 */
export function emitPatch(promptId: string, request: UpstreamRequest, sim: unknown): PatchResult {
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

  // `timingSafeEqual` proto, že rozdíl v době odpovědi je oracle: kdo umí měřit,
  // umí očekávaný otisk uhodnout po bajtech místo celý naráz. Obě strany jsou
  // hex téže délky, takže `Buffer.from` dá vždy shodně dlouhé pole.
  const actual = simFingerprint(sim);
  if (!timingSafeEqual(Buffer.from(expected.value, 'hex'), Buffer.from(actual, 'hex')))
    return {
      ok: false,
      reason: 'BASE_WORLD_MISMATCH',
      detail: `${promptId} was authored against ${baseWorld}; the submitted world does not carry that sim part`,
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
 * Otisk `sim` části základního světa, spočítaný z jeho zmrazené create emise.
 *
 * Počítá se **z oloupaného** těla: anotace obálky (`simOutcome` a spol.) jedou
 * vedle dokumentu a do hashe nikdy nevstupují — tak, jak je pečetí `/api/emit`.
 * Kdyby se hashovalo syrové tělo, čtyři anotované create světy by měly jiný
 * otisk tady než tam a vazba by je odmítla, přestože se nic nezměnilo.
 */
function frozenBaseSimHash(baseWorld: string): Read<string> {
  const record = verifiedRecord(baseWorld, 'create');
  // Chybějící základní svět je vada **korpusu**, ne dotazu. Bez téhle výměny by
  // ji endpoint vydal jako 404 nad dvojicí, tedy jako naměřený výsledek —
  // a rozbité prostředí se skórovat nesmí.
  if (!record.ok)
    return record.reason === 'NO_FROZEN_RESPONSE'
      ? {
          ok: false,
          reason: 'BASE_WORLD_MISSING',
          detail: `an edit record names base world ${baseWorld}, which the frozen corpus does not contain`,
        }
      : record;

  const peeled = peelEnvelope(record.value.entry.body);
  if (peeled === null || !Object.hasOwn(peeled.document, 'sim'))
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `the frozen create response for ${baseWorld} carries no sim part to bind against`,
    };

  return { ok: true, value: simFingerprint(peeled.document.sim) };
}
