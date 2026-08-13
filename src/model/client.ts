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
 * 1. **hash souboru proti `MANIFEST.lock`** (`files["responses/index.jsonl"]`) —
 *    zachytí přepsaný, doplněný nebo odebraný záznam. Bez něj by stačilo do
 *    souboru dopsat řádek s vlastní odpovědí a per-record hash by na ni seděl,
 *    protože by se počítal z ní samé.
 * 2. **per-record `sha256` nad `JSON.stringify(record.body)`** — `MANIFEST.lock`
 *    to předepisuje doslova (`responseBodyHashRule`) a zachytí tělo vyměněné za
 *    jiné uvnitř jinak nedotčeného souboru.
 *
 * Ani jedna z nich nedokazuje, že soubor sedí na commitnutý strom — to hlídá
 * `evals/__tests__/frozen.test.ts`. Tady jde o to, aby produkční cesta nikdy
 * nevydala odpověď, kterou zmrazení nekryje.
 *
 * **Hlavička `synthetic: true` není formalita.** Tyhle záznamy neříkají nic
 * o kvalitě modelu; prokazují správnost potrubí. Kvalitu měří až živý běh za
 * HALT bránou (T18). Klient proto hlavičku vyžaduje a propouští ji do
 * provenience, aby se výsledek nedal vydávat za měření modelu.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Grammar, UpstreamRequest } from './prompt';

const FROZEN_DIR = join(process.cwd(), 'evals', 'frozen');
const RESPONSES_FILE = 'responses/index.jsonl';

export type ClientReason =
  /** Zmrazený soubor se rozešel s `MANIFEST.lock`. */
  | 'MANIFEST_MISMATCH'
  /** Pro tenhle prompt zmrazená odpověď neexistuje. */
  | 'NO_FROZEN_RESPONSE'
  /** Tělo se rozešlo s vlastním `sha256`, nebo mu chybí hlavička. */
  | 'RESPONSE_TAMPERED';

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

/**
 * `MANIFEST.lock` normalizuje CRLF na LF **před** hashováním. Bez toho by hash
 * téhož souboru závisel na stroji, na kterém se repo checkoutovalo.
 */
function normalisedSha256(absolutePath: string): string {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
}

function readJsonl(relativePath: string): Record<string, unknown>[] {
  return readFileSync(join(FROZEN_DIR, relativePath), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Slovník ze zmrazeného protokolu — prompt si ho nesmí opsat. */
export function frozenGrammar(): Grammar {
  const protocol = JSON.parse(readFileSync(join(FROZEN_DIR, 'protocol.v1.json'), 'utf8')) as {
    grammar: { surfaceEvents: string[]; conditions: string[]; actions: string[] };
    worldDoc: { sim: { fields: string[] }; look: { fields: string[] } };
  };
  return {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
}

export interface FrozenPrompt {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
}

/** Zmrazený prompt podle id, nebo `null`. Endpoint z toho dělá 404, ne 500. */
export function frozenPrompt(id: string): FrozenPrompt | null {
  const found = readJsonl('prompts.v1.jsonl').find((record) => record.id === id);
  if (found === undefined || typeof found.prompt !== 'string' || typeof found.kind !== 'string') return null;
  return { id, kind: found.kind, prompt: found.prompt };
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
  const manifest = JSON.parse(readFileSync(join(FROZEN_DIR, 'MANIFEST.lock'), 'utf8')) as {
    files: Record<string, string>;
  };
  const expected = manifest.files[RESPONSES_FILE];
  const actual = normalisedSha256(join(FROZEN_DIR, RESPONSES_FILE));
  if (expected !== actual)
    return {
      ok: false,
      reason: 'MANIFEST_MISMATCH',
      detail: `${RESPONSES_FILE} hashes to ${actual}, MANIFEST.lock says ${String(expected)}`,
    };

  const record = readJsonl(RESPONSES_FILE).find(
    (entry) => entry.forPrompt === promptId && entry.branch === 'create',
  );
  if (record === undefined)
    return { ok: false, reason: 'NO_FROZEN_RESPONSE', detail: `no frozen create response for ${promptId}` };

  if (record.synthetic !== true)
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `response for ${promptId} does not declare synthetic: true`,
    };

  const bodySha256 = createHash('sha256').update(JSON.stringify(record.body)).digest('hex');
  if (bodySha256 !== record.sha256)
    return {
      ok: false,
      reason: 'RESPONSE_TAMPERED',
      detail: `body for ${promptId} hashes to ${bodySha256}, the record claims ${String(record.sha256)}`,
    };

  return {
    ok: true,
    body: record.body,
    request,
    provenance: {
      source: 'frozen-manifest',
      synthetic: true,
      file: RESPONSES_FILE,
      bodySha256,
      declaredVerdict: String(record.expectedVerdict),
    },
  };
}
