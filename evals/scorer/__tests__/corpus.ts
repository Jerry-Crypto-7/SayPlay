/**
 * Zmrazený korpus jako **důkazní materiál** pro scorer.
 *
 * Scorer sám nic nespouští — dostává hotový výsledek potrubí (`Evidence`).
 * Tenhle pomocník ten výsledek vyrobí ze zmrazených syntetických odpovědí, aby
 * se testy T16 daly psát proti skutečným tělům, ne proti ručním fixturám.
 *
 * **Není to offline řetězec.** Ten je AC úlohy T17 a měří pět stadií s hashovým
 * řetězením. Tady jde jen o to, dostat k scoreru `create` dokument a `edit`
 * dvojici před/po, vyrobenou **skutečným** `commitPart`, ne ručním sloučením.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { commitPart } from '../../../src/ir/revision';
import { peelEnvelope, type WorldDoc } from '../../../src/ir/worlddoc';
import { routePatch } from '../../../src/patch/router';
import { loadContracts, type Contract, type Evidence, type Verdict } from '../semantic';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export interface FrozenResponse {
  readonly synthetic: boolean;
  readonly forPrompt: string;
  readonly branch: 'create' | 'edit';
  readonly baseWorld?: string;
  readonly expectedVerdict: Verdict;
  readonly body: unknown;
}

export function loadResponses(): readonly FrozenResponse[] {
  return readFileSync(join(repoRoot, 'evals', 'frozen', 'responses', 'index.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FrozenResponse);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface FrozenCase {
  readonly id: string;
  readonly contract: Contract;
  readonly evidence: Evidence;
  /** Verdikt, který korpus deklaruje. Testy T16 ho NEasertují — to dělá T17. */
  readonly declared: Verdict;
}

/**
 * Aplikuje editační patch přes skutečnou cestu: router, pak `commitPart`.
 *
 * Router tu není kosmetika — patche korpusu mluví v souřadnicích **dokumentu**
 * (`/sim/rules/...`), zatímco `commitPart` klonuje jen `doc.sim`. Přepis do
 * souřadnic části dělá `routePatch`, a dělá ho jako důsledek rozhodnutí o dráze,
 * ne strháváním prefixu naslepo.
 *
 * Odmítnutí je `fault`: v téhle dvojici je odmítnutí jedině nevalidní patch nebo
 * zastaralá revize, a obojí je pád emise, ne poctivé „to neumím". `NO_FIT`
 * rozhoduje až certifikace ve verifikátoru, a ta patří do řetězce T17.
 */
export function applyEdit(before: unknown, operations: unknown): Evidence {
  const routed = routePatch({ operations: operations as never });
  if (routed.verdict !== 'ROUTED')
    return { kind: 'edit', outcome: 'fault', sceneBuilt: true, detail: `${routed.reason} ${routed.pointer}` };

  let doc = before as WorldDoc;
  for (const patch of routed.patches) {
    const result = commitPart(doc, {
      part: patch.part,
      baseRevision: patch.part === 'sim' ? doc.simRevision : doc.lookRevision,
      operations: patch.operations,
    });
    if (result.verdict !== 'COMMITTED')
      return { kind: 'edit', outcome: 'fault', sceneBuilt: true, detail: `${result.reason} ${result.pointer} — ${result.detail}` };
    doc = result.doc;
  }
  return { kind: 'edit', outcome: 'committed', before, after: doc, sceneBuilt: true };
}

export function frozenCases(): readonly FrozenCase[] {
  const contracts = new Map(loadContracts().map((contract) => [contract.id, contract]));
  const responses = loadResponses();
  const bodyById = new Map(responses.map((response) => [response.forPrompt, response.body]));

  return responses.map((response) => {
    const contract = contracts.get(response.forPrompt);
    if (contract === undefined) throw new Error(`prompt ${response.forPrompt} nemá kontrakt`);

    if (response.branch === 'create') {
      // `simOutcome: "NO_FIT"` je obálková anotace emisní cesty (§13.4): `sim` se
      // odmítlo, scéna se přesto postavila. Číst ji tady znamená, že se poctivé
      // odmítnutí nedostane ke scoreru převlečené za postavený svět.
      const declined = peelEnvelope(response.body)?.annotations.simOutcome === 'NO_FIT';
      return {
        id: response.forPrompt,
        contract,
        declared: response.expectedVerdict,
        evidence: declined
          ? ({ kind: 'create', outcome: 'declined', sceneBuilt: true } satisfies Evidence)
          : ({ kind: 'create', outcome: 'emitted', doc: clone(response.body), sceneBuilt: true } satisfies Evidence),
      };
    }

    const base = bodyById.get(response.baseWorld ?? '');
    if (base === undefined) throw new Error(`${response.forPrompt} nemá základní svět`);
    return {
      id: response.forPrompt,
      contract,
      declared: response.expectedVerdict,
      evidence: applyEdit(clone(base), clone(response.body)),
    };
  });
}
