/**
 * `POST /api/edit` nad **celou** zmrazenou editační sadou.
 *
 * Oracle úlohy je e2e sada proti běžícímu `next start`; tahle je vedle ní a má
 * jiný úkol — **pokrýt všech 25 promptů**, ne jednu reprezentativní cestu. Brána
 * nad T13 našla přesně tu díru: e2e jelo na 7 z 15 a obě zbylé vady ležely
 * v nepokryté polovině.
 *
 * ## Oracle nečte tutéž cestu jako implementace
 *
 * Rozvinutá množina změněných listů se tu počítá **vlastním** průchodem
 * (`measuredLeaves` níž), ne přes `src/patch/scope.ts`. Kdyby test volal touž
 * funkci jako route, dokázal by jen to, že se implementace shoduje sama se
 * sebou — přesně ten kruhový oracle, kvůli kterému vznikl bod (2) AC T8b
 * a který si tenhle projekt zaplatil dvakrát. Shoda obou výpočtů se pak asertuje
 * zvlášť, což je křížová kontrola, ne zdroj pravdy.
 */

import { readFileSync } from 'node:fs';
import { applyPatch, type Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import { peelEnvelope, sealSimHash, type WorldDoc } from '../../../../ir/worlddoc';
import { POST } from '../route';

// ---------------------------------------------------------------------------
// Zmrazený korpus, čtený nezávisle na `src/model/client.ts`
// ---------------------------------------------------------------------------

function jsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

interface AllowedPath {
  readonly op: string;
  readonly path: string;
}

interface FrozenContract {
  readonly id: string;
  readonly kind: string;
  readonly editClass?: string;
  readonly baseWorld?: string;
  readonly verdictCeiling?: string;
  readonly allowedPaths?: readonly AllowedPath[];
}

interface FrozenResponse {
  readonly forPrompt: string;
  readonly branch: string;
  readonly baseWorld?: string;
  readonly modelLabel?: string;
  readonly expectedVerdict: string;
  readonly body: unknown;
}

const contracts = jsonl<FrozenContract>('evals/frozen/contracts.v1.jsonl').filter(
  (contract) => contract.kind === 'edit',
);
const responses = jsonl<FrozenResponse>('evals/frozen/responses/index.jsonl');
const editResponses = responses.filter((record) => record.branch === 'edit');
const ids = contracts.map((contract) => contract.id);

/** Základní svět zapečetěný přesně tak, jak ho pečetí `/api/emit`. */
function baseDoc(baseWorld: string): WorldDoc {
  const record = responses.find((item) => item.branch === 'create' && item.forPrompt === baseWorld);
  if (record === undefined) throw new Error(`frozen create response ${baseWorld} is missing`);
  const peeled = peelEnvelope(record.body);
  if (peeled === null) throw new Error(`frozen create body ${baseWorld} is not an object`);
  return sealSimHash(peeled.document as unknown as WorldDoc) as WorldDoc;
}

function contractOf(id: string): FrozenContract {
  const found = contracts.find((contract) => contract.id === id);
  if (found === undefined) throw new Error(`frozen edit contract ${id} is missing`);
  return found;
}

function responseOf(id: string): FrozenResponse {
  const found = editResponses.find((record) => record.forPrompt === id);
  if (found === undefined) throw new Error(`frozen edit response ${id} is missing`);
  return found;
}

// ---------------------------------------------------------------------------
// Vlastní rozvinutí dosahu — NEZÁVISLÉ na `src/patch/scope.ts`
// ---------------------------------------------------------------------------

const escape = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = (tokens: readonly string[]): string => tokens.map((token) => `/${escape(token)}`).join('');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function leavesOf(value: unknown, tokens: string[], out: Set<string>): void {
  if (value === undefined) return;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return void out.add(pointer(tokens));
    for (const key of keys) leavesOf(value[key], [...tokens, key], out);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return void out.add(pointer(tokens));
    value.forEach((item, index) => leavesOf(item, [...tokens, String(index)], out));
    return;
  }
  out.add(pointer(tokens));
}

/** Rovnost hodnot vlastním porovnáním, ne `canonical` z produkčního kódu. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => same(a[key], b[key]));
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => same(item, b[index]));
  return false;
}

type LeafEffect = 'add' | 'remove' | 'replace';

interface MeasuredLeaf {
  readonly path: string;
  readonly effect: LeafEffect;
}

/**
 * `same` rozlišuje `null` od chybějícího klíče, protože `Object.is(null, undefined)`
 * je `false` — a je to tady schválně napsané vlastním porovnáním, ne `canonical`
 * z produkce, právě aby ta dvojice nesplynula. Produkční `scope.ts` ji dřív
 * slučovala a smazání `null` listu vykázala jako nulový dosah.
 */
function diffLeaves(before: unknown, after: unknown, tokens: string[], out: Map<string, LeafEffect>): void {
  if (same(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      diffLeaves(before[key], after[key], [...tokens, key], out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i += 1)
      diffLeaves(before[i], after[i], [...tokens, String(i)], out);
    return;
  }
  // Účinek na adrese rozchodu; listy pod ní ho dědí. Je na obou stranách =
  // `replace`, i když se z listu stal vnitřní uzel (`null` → objekt).
  const effect: LeafEffect = before === undefined ? 'add' : after === undefined ? 'remove' : 'replace';
  const touched = new Set<string>();
  leavesOf(before, tokens, touched);
  leavesOf(after, tokens, touched);
  for (const path of touched) out.set(path, effect);
}

/**
 * Dosah patche, změřený **aplikací a diffem stavu** — tak, jak to žádá
 * `editContract.changedLeafRule`, a bez jediného pohledu do operací.
 */
function measuredLeafEffects(before: WorldDoc, operations: readonly Operation[]): readonly MeasuredLeaf[] {
  const draft = structuredClone(before) as unknown as Record<string, unknown>;
  applyPatch(draft, structuredClone(operations) as Operation[]);
  const out = new Map<string, LeafEffect>();
  diffLeaves(before.sim, draft.sim, ['sim'], out);
  diffLeaves(before.look, draft.look, ['look'], out);
  return [...out.keys()].sort().map((path) => ({ path, effect: out.get(path) as LeafEffect }));
}

function measuredLeaves(before: WorldDoc, operations: readonly Operation[]): readonly string[] {
  return measuredLeafEffects(before, operations).map((leaf) => leaf.path);
}

/**
 * Je změněný list uvnitř kontraktu — **cestou i operací**?
 *
 * **Na deklarované cestě, nebo pod ní. Nikdy nad ní.** Sestup je legální —
 * `replace /sim/layout/portals` deklaruje celý ten podstrom a jeho listy se
 * vyjmenovat dopředu nedají. Výstup legální není, a v tom je celý rozdíl proti
 * čtení operací: kontrola typu „cesta operace je prefixem některé povolené"
 * propustí `replace /sim`, protože `/sim` je prefixem úplně každé povolené cesty.
 * Rozvinutý list `/sim/state/timers/flood/init` naproti tomu neleží pod
 * `/sim/state/timers/flood/durationTicks`, takže se ukáže.
 *
 * **Druhá půlka je operace, a bez ní byla kontrola poloviční.** `allowedPaths`
 * deklaruje dvojice `{op, path}` a AC úlohy mluví doslova o *dvojicích
 * operace–cesta*. Dokud se porovnávala jen cesta, kontrakt `E21` povolující
 * `add /sim/state/counters/keysReturned` propustil i `remove` téhož counteru —
 * tedy pravý opak deklarovaného záměru nad toutéž adresou.
 *
 * Porovnává se na **přesné** cestě, protože tam kontrakt tvrdí právě jednu věc.
 * Při sestupu pod deklarovanou cestu platí operace na celý podstrom: `replace`
 * podstromu uvnitř legálně přidává i maže klíče (nová hodnota má jiný tvar),
 * kdežto `add` podstromu uvnitř jen přidává a `remove` jen maže. Vyžadovat
 * shodu i tam by vyrobilo falešné nálezy nad `replace` celého objektu.
 */
function insideContract(leaf: MeasuredLeaf, allowed: readonly AllowedPath[]): boolean {
  return allowed.some((entry) => {
    if (leaf.path === entry.path) return leaf.effect === entry.op;
    if (!leaf.path.startsWith(`${entry.path}/`)) return false;
    return entry.op === 'replace' || leaf.effect === entry.op;
  });
}

// ---------------------------------------------------------------------------
// Volání endpointu
// ---------------------------------------------------------------------------

interface EditBody {
  readonly promptId: string;
  readonly baseWorld: string;
  readonly outcome: 'CERTIFIED' | 'REJECTED';
  readonly patch: readonly Operation[];
  readonly label: string | null;
  readonly lanes: readonly string[];
  readonly applied: readonly string[];
  readonly changedLeaves: readonly string[];
  readonly revisions: {
    readonly sim: { readonly before: number; readonly after: number };
    readonly look: { readonly before: number; readonly after: number };
  };
  readonly certificate: { readonly verdict: string; readonly reason?: string } | null;
  readonly anomalies: readonly { readonly kind: string; readonly label: string; readonly evidence: string }[];
  readonly rejection: { readonly stage: string; readonly reason: string; readonly detail: string } | null;
  readonly upstream: { readonly model: string; readonly system: string; readonly user: string };
  readonly provenance: { readonly synthetic: boolean; readonly source: string };
}

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(
    new Request('http://127.0.0.1/api/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function edit(promptId: string, doc?: WorldDoc, revision?: { sim: number; look: number }): Promise<EditBody> {
  const world = doc ?? baseDoc(contractOf(promptId).baseWorld as string);
  const response = await post({
    worldDoc: world,
    baseRevision: revision ?? { sim: world.simRevision, look: world.lookRevision },
    promptId,
  });
  expect(response.status, `${promptId} musí odpovědět 200 s verdiktem: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body as unknown as EditBody;
}

// ---------------------------------------------------------------------------

describe('celá zmrazená editační sada projde endpointem', () => {
  it('má právě 25 editačních promptů a žádný z nich nekončí 5xx', async () => {
    expect(ids.length).toBe(25);
    for (const id of ids) {
      const body = await edit(id);
      expect(['CERTIFIED', 'REJECTED'], id).toContain(body.outcome);
    }
  });

  it('vrací patch, ne svět — dokument v odpovědi není', async () => {
    // Failure signal Oracle úlohy doslova: *„vrácený celý `WorldDoc` místo
    // patche"*. Celý přeemitovaný svět by hráči sebral stav a zrušil jedinou
    // věc, kterou jde na editaci měřit — ohraničený dosah.
    for (const id of ids) {
      const body = await edit(id);
      expect(Array.isArray(body.patch), `${id} nevydal RFC 6902 pole operací`).toBe(true);
      expect(body, id).not.toHaveProperty('doc');
      expect(body, id).not.toHaveProperty('worldDoc');
      for (const operation of body.patch) {
        expect(typeof operation.op, `${id}: operace bez op`).toBe('string');
        expect(operation.path, `${id}: cesta mimo obě části`).toMatch(/^\/(sim|look)(\/|$)/);
      }
    }
  });

  it('zaznamenaný upstream nese text promptu a provenienci zmrazeného záznamu', async () => {
    const prompts = jsonl<{ id: string; prompt: string }>('evals/frozen/prompts.v1.jsonl');
    for (const id of ids) {
      const body = await edit(id);
      const text = prompts.find((entry) => entry.id === id)?.prompt as string;
      expect(body.upstream.user, `${id}`).toContain(text);
      expect(body.provenance.synthetic, id).toBe(true);
      expect(body.provenance.source, id).toBe('frozen-manifest');
    }
  });
});

describe('dosah patche — rozvinutá množina listů proti `allowedPaths`', () => {
  /**
   * **Naměřený rozpor korpusu, ne tolerance implementace.**
   *
   * Osm zmrazených editačních záznamů hýbe listy mimo `allowedPaths` svého
   * kontraktu. Je to zapsané v `CLAUDE.md` („Nedořešené rozpory" #4b) jako
   * vědomě neopravené: **AC T2b zakazuje měnit prompty i kontrakty**, takže se
   * korpus srovnat nesmí a jediná poctivá odpověď je rozpor změřit a připnout.
   *
   * Seznam se asertuje **oběma směry**: nový rozpor sadu shodí a zmizelý taky.
   * Bez té druhé půlky by to nebyla míra, ale výjimka, která se sama rozšiřuje.
   *
   * Příčiny, každá naměřená nad základním světem záznamu:
   * - `E01` — mění `init` vedle deklarovaného `durationTicks` (nutná kolaterála:
   *   běžící timer by jinak dobíhal na starou hodnotu)
   * - `E04` — neguje operand **0**, kontrakt žádá operand **1**
   * - `E13`, `E14`, `E15` — smazání s kolaterálou mimo deklarované cesty
   * - `E16` — přesun pochodně nese `collisionAabb`, který kontrakt nejmenuje
   * - `E22`, `E23` — záměna cíle sahá na sousední pravidlo
   */
  const CONTRACT_OVERRUN = ['E01', 'E04', 'E13', 'E14', 'E15', 'E16', 'E22', 'E23'];

  /** Záznamy, jejichž patch se na svůj základní svět vůbec nedá aplikovat. */
  const UNAPPLICABLE = ['E06', 'E19', 'E20', 'E24'];

  it('endpoint počítá dosah stejně jako nezávislé měření testu', async () => {
    // Křížová kontrola, ne zdroj pravdy: obě strany počítají rozvinuté listy
    // vlastním kódem a musí se sejít. Kdyby test četl jen pole z odpovědi,
    // dokazoval by, že se implementace shoduje sama se sebou.
    for (const id of ids) {
      const world = baseDoc(contractOf(id).baseWorld as string);
      const body = await edit(id);
      if (!body.applied.includes('sim') && !body.applied.includes('look')) {
        expect(body.changedLeaves, `${id}: neaplikovaný patch nemá dosah`).toEqual([]);
        continue;
      }
      expect(body.changedLeaves, `${id}`).toEqual(measuredLeaves(world, responseOf(id).body as Operation[]));
    }
  });

  it('neaplikovatelné záznamy jsou naměřené odmítnutí, ne 5xx a ne tichý průchod', async () => {
    const measured: string[] = [];
    for (const id of ids) {
      const body = await edit(id);
      if (body.rejection?.stage === 'apply') measured.push(id);
    }
    expect(measured.sort()).toEqual([...UNAPPLICABLE].sort());
  });

  it('rozvinutý dosah leží uvnitř `allowedPaths` — mimo přesně osm naměřených rozporů korpusu', async () => {
    const overrun: string[] = [];
    for (const id of ids) {
      if (UNAPPLICABLE.includes(id)) continue;
      const contract = contractOf(id);
      const world = baseDoc(contract.baseWorld as string);
      const leaves = measuredLeafEffects(world, responseOf(id).body as Operation[]);
      const allowed = contract.allowedPaths ?? [];
      const outside = leaves.filter((leaf) => !insideContract(leaf, allowed));
      if (outside.length > 0) overrun.push(id);
    }
    expect(overrun.sort()).toEqual([...CONTRACT_OVERRUN].sort());
  });

  it('`replace` na předkovi neprojde, i když čtení operací by ho pustilo', async () => {
    // **Tohle je jádro AC a schválně se neopírá o korpus.** Kontrakt `E01`
    // povoluje jedinou cestu — `/sim/state/timers/flood/durationTicks`. Patch
    // níž přepíše jejího **předka**, tedy celý `flood`.
    //
    // Kontrola čtením operací ho pustí: cesta operace je prefixem povolené
    // cesty, což je nejpřirozenější implementace „leží uvnitř kontraktu".
    // Rozvinutá množina listů ho nepustí, protože ukáže i `init`, který se
    // změnil s ním. Review v4 (Q3/T14) žádá přesně tenhle rozdíl.
    const world = baseDoc('C02');
    const allowed = contractOf('E01').allowedPaths as readonly AllowedPath[];
    const ancestor = '/sim/state/timers/flood';
    const sneaky: Operation[] = [{ op: 'replace', path: ancestor, value: { durationTicks: 2400, init: 1, min: 0, max: 2400 } }];

    // Čtení operací: prefixová shoda projde. Tohle je ta děravá kontrola.
    const byOperations = sneaky.every((operation) =>
      allowed.some((entry) => entry.path === operation.path || entry.path.startsWith(`${operation.path}/`)),
    );
    expect(byOperations, 'předpoklad testu padl: čtení operací už tenhle patch nepouští').toBe(true);

    // Rozvinutá množina listů: `init` je vidět a leží mimo kontrakt.
    const leaves = measuredLeafEffects(world, sneaky);
    const outside = leaves.filter((leaf) => !insideContract(leaf, allowed));
    expect(outside.length, `rozvinutý dosah nechytil přepis předka: ${JSON.stringify(leaves)}`).toBeGreaterThan(0);
    expect(outside.map((leaf) => leaf.path)).toContain('/sim/state/timers/flood/init');
  });

  it('operace je druhá půlka kontraktu — `remove` tam, kde se deklaruje `add`, neprojde', () => {
    // **Nález brány nad T14.** `allowedPaths` deklaruje dvojice `{op, path}`
    // a AC mluví doslova o *dvojicích operace–cesta*. Dokud se porovnávala jen
    // cesta, prošel nad deklarovaným `add` i jeho pravý opak: smazání téže
    // adresy. Kontrakt `E25` deklaruje `add /sim/state/counters/tagged`.
    const allowed = contractOf('E25').allowedPaths as readonly AllowedPath[];
    const path = '/sim/state/counters/tagged';
    expect(
      allowed.some((entry) => entry.op === 'add' && entry.path === path),
      'korpus se pohnul: `E25` už tuhle dvojici nedeklaruje',
    ).toBe(true);

    expect(insideContract({ path, effect: 'add' }, allowed)).toBe(true);
    expect(insideContract({ path, effect: 'remove' }, allowed)).toBe(false);
    expect(insideContract({ path, effect: 'replace' }, allowed)).toBe(false);
  });

  it('sestup dědí operaci: pod `replace` se smí přidávat, pod `add` ne mazat', () => {
    const allowed = contractOf('E25').allowedPaths as readonly AllowedPath[];

    // `replace /sim/rules/win/condition` — nová hodnota má jiný tvar, takže se
    // uvnitř legálně objeví klíč, který tam dřív nebyl. Vyžadovat i tady shodu
    // účinku by vyrobilo falešný nález nad každým `replace` celého objektu.
    expect(insideContract({ path: '/sim/rules/win/condition/zone', effect: 'add' }, allowed)).toBe(true);

    // `add /sim/rules/tag` — podstrom je nový, takže uvnitř nemá co ztratit.
    expect(insideContract({ path: '/sim/rules/tag/actions/0/by', effect: 'add' }, allowed)).toBe(true);
    expect(insideContract({ path: '/sim/rules/tag/actions/0/by', effect: 'remove' }, allowed)).toBe(false);
  });

});

describe('dráhu rozhodují cesty, ne štítek', () => {
  it('štítek `look` nad cestami pod `/sim` skončí v dráze pravidel a zanechá anomálii', async () => {
    // Zmrazená sada nese tenhle případ schválně (T2: *„Dva patche nesou štítek
    // `look` nad cestami pod `/sim` — jediný offline důkaz pro anomální větev
    // routeru"*). Ověřuje se obojí: že rozhodly cesty **a** že patch prošel —
    // neshoda štítku je podle protokolu telemetrie, ne důvod k odmítnutí.
    const mislabelled = editResponses.filter((record) => record.modelLabel !== undefined && record.modelLabel !== 'sim');
    expect(mislabelled.length, 'zmrazená sada přestala nést špatně oštítkovaný patch').toBeGreaterThan(0);

    for (const record of mislabelled) {
      const body = await edit(record.forPrompt);
      expect(body.lanes, `${record.forPrompt}: štítek přebil cesty`).toEqual(['rules']);
      expect(body.anomalies.length, `${record.forPrompt}: anomálie se nezaznamenala`).toBe(1);
      expect(body.anomalies[0].kind).toBe('label-mismatch');
      expect(body.anomalies[0].label).toBe(record.modelLabel);
      expect(body.rejection?.stage, `${record.forPrompt}: neshoda štítku nesmí být důvod k odmítnutí`).not.toBe(
        'routing',
      );
    }
  });

  it('každá dráha je odvozená z cest, ne z toho, co model prohlásil', async () => {
    for (const id of ids) {
      const body = await edit(id);
      const parts = new Set((responseOf(id).body as Operation[]).map((operation) => operation.path.split('/')[1]));
      const expected = [...parts].map((part) => (part === 'sim' ? 'rules' : 'look'));
      expect([...body.lanes].sort(), id).toEqual(expected.sort());
    }
  });
});

describe('dvě revize, dvě nezávislé kontroly zastaralosti', () => {
  it('`sim` patch prochází se zastaralou `lookRevision` a padá na zastaralé `simRevision`', async () => {
    // §13.1.1 celý: se sdílenou revizí by vzhledový commit uprostřed verifikace
    // `sim` odmítl patch pravidel jako zastaralý, ačkoli se na `sim` nezměnilo
    // nic. Obě aserce dohromady — bez té první by prošla i implementace, která
    // odmítá cokoli, co se nerovná oběma revizím.
    const world = baseDoc(contractOf('E01').baseWorld as string);

    const staleLook = await post({
      worldDoc: world,
      baseRevision: { sim: world.simRevision, look: world.lookRevision + 7 },
      promptId: 'E01',
    });
    expect(staleLook.status, 'zastaralá `lookRevision` nesmí zastavit patch pravidel').toBe(200);
    expect(staleLook.body.outcome).toBe('CERTIFIED');

    const staleSim = await post({
      worldDoc: world,
      baseRevision: { sim: world.simRevision + 7, look: world.lookRevision },
      promptId: 'E01',
    });
    expect(staleSim.status).toBe(409);
    expect((staleSim.body.error as { code: string }).code).toBe('STALE_REVISION');
    expect((staleSim.body.error as { field: string }).field).toBe('baseRevision/sim');
  });

  it('409 chytí vnitřní rozpor požadavku, ne zastaralost proti světu, který drží někdo jiný', async () => {
    // **Meze brány, změřené a připnuté — ne tvrzení, že mez neexistuje.**
    // Endpoint je bezstavový: „aktuální" revizi zná jen z dokumentu, který mu
    // poslal týž volající. `simHash` navíc kryje `doc.sim` a nic víc (zmrazený
    // protokol), takže revize hashem vázané nejsou. Volající dvě kola pozadu
    // proto projde — jeho dokument a jeho `baseRevision` spolu souhlasí.
    //
    // Je to vlastnost bezstavového endpointu, ne vada implementace, a stojí to
    // tady napsané proto, aby si to nikdo nespletl s optimistickým zámkem nad
    // sdíleným světem. Ten by potřeboval server, který si světy drží; v P1
    // neexistuje a T14 ho stavět nemá.
    const world = baseDoc(contractOf('E01').baseWorld as string);
    const behind = { ...world, simRevision: world.simRevision + 5, lookRevision: world.lookRevision + 5 };

    const consistent = await post({
      worldDoc: behind,
      baseRevision: { sim: behind.simRevision, look: behind.lookRevision },
      promptId: 'E01',
    });
    expect(consistent.status, 'sám se sebou souhlasící požadavek 409 nedostane').toBe(200);

    // A totéž číslo v rozporu s dokumentem 409 dostane — bez téhle druhé
    // poloviny by aserce výš prošla i endpointu, který 409 nevrací nikdy.
    const contradictory = await post({
      worldDoc: behind,
      baseRevision: { sim: world.simRevision, look: behind.lookRevision },
      promptId: 'E01',
    });
    expect(contradictory.status).toBe(409);
  });

  it('409 se rozhodne PŘED aplikací — revize v odpovědi se nepohnuly', async () => {
    const world = baseDoc(contractOf('E01').baseWorld as string);
    const stale = await post({
      worldDoc: world,
      baseRevision: { sim: world.simRevision - 1 < 0 ? 99 : world.simRevision + 1, look: world.lookRevision },
      promptId: 'E01',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.revisions).toEqual({
      sim: { before: world.simRevision, after: world.simRevision },
      look: { before: world.lookRevision, after: world.lookRevision },
    });
  });

  it('commit zvedne právě tu revizi, které se patch týkal', async () => {
    const body = await edit('E01');
    expect(body.outcome).toBe('CERTIFIED');
    expect(body.revisions.sim.after).toBe(body.revisions.sim.before + 1);
    expect(body.revisions.look.after).toBe(body.revisions.look.before);
  });
});

describe('svědek se po editaci ověřuje znovu', () => {
  it('certifikovaný patch nese čerstvý certifikát, odmítnutý nese důvod', async () => {
    const measured: Record<string, string> = {};
    for (const id of ids) {
      const body = await edit(id);
      measured[id] =
        body.outcome === 'CERTIFIED'
          ? `CERTIFIED/${String(body.certificate?.verdict)}`
          : `REJECTED/${body.rejection?.stage}:${body.rejection?.reason}`;
      if (body.outcome === 'CERTIFIED') {
        expect(body.certificate?.verdict, `${id}: certifikovaný patch bez certifikátu`).toBe('CERTIFIED');
        expect(body.applied, `${id}`).toContain('sim');
      }
    }

    // Pinovaná mapa — **naměřeno, ne zvoleno**. Když se pokrytí pohne, čísla se
    // rozejdou a je to vidět místo aby to tiše prošlo.
    expect(measured).toMatchSnapshot();
  });

  it('naměřený rozpor: `witnessPreserved: false` proti pravidlu „necertifikovaná `sim` se neaplikuje"', async () => {
    // **Nic se tu nepovoluje — měří se konflikt dvou zmrazených pravidel.**
    //
    // `requirementKinds.edit.witnessPreserved` říká: *„starý svědek musí (true)
    // nebo nemusí (false) dál dojít do výhry"*. 17 z 25 kontraktů deklaruje
    // `false`, tedy že ztráta staré vítězné stopy je legální výsledek editace.
    // Architektura P1 přitom stojí na tom, že **žádný přijatý svět není bez
    // ověřeného svědka** — takže endpoint necertifikovanou `sim` neaplikuje.
    //
    // Obojí naráz platit nemůže, dokud patch nevyrobí svědka **nového**.
    // Naměřeno: ani jeden z 25 zmrazených patchů nesahá na `/sim/witness`.
    // Celá třída `goal_swap` (E21–E25) tím zůstane neaplikovatelná, přestože
    // §15 pro ni má vlastní podlahu.
    //
    // Rozhodnutí patří k T16 (scorer čte `witnessPreserved`) a T17 (ten na
    // distribuci verdiktů stojí), ne sem: změkčit endpoint, aby čísla vyšla, je
    // přesně to ladění metriky podle výsledku, které tenhle projekt zakazuje.
    const touchesWitness = editResponses.filter((record) =>
      (record.body as Operation[]).some((operation) => operation.path.startsWith('/sim/witness')),
    );
    expect(touchesWitness.map((record) => record.forPrompt)).toEqual([]);

    const permitted: string[] = [];
    const contradicts: string[] = [];
    for (const id of ids) {
      const body = await edit(id);
      if (body.rejection?.stage !== 'witness') continue;
      const declared = (contractOf(id) as { requirements?: { kind: string; value: unknown }[] }).requirements?.find(
        (requirement) => requirement.kind === 'witnessPreserved',
      );
      (declared?.value === false ? permitted : contradicts).push(id);
    }

    // Kontrakt ztrátu svědka POVOLUJE, endpoint patch přesto neaplikuje.
    expect(permitted.sort()).toEqual(['E02', 'E07', 'E08', 'E17', 'E21', 'E22', 'E23']);
    // Kontrakt zachování svědka VYŽADUJE a zmrazený patch ho stejně ztratí —
    // tohle je rozpor uvnitř korpusu a na volbě endpointu nezávisí.
    expect(contradicts.sort()).toEqual(['E13', 'E14']);
  });

  it('necertifikovaná `sim` se neaplikuje a nevykáže jediný `sim` list', async () => {
    // **Měří se dosah té části, která se neaplikovala, ne prázdnota celé odpovědi.**
    // Dřívější znění tvrdilo `changedLeaves === []` pro každý necertifikovaný
    // záznam. Drží to jen proto, že zmrazená sada nemá smíšený patch, jehož `look`
    // půlka commitne a `sim` půlka padne na svědkovi — a ten by legálně vykázal
    // `look` listy (`route.ts` je do dosahu započítá podle `applied`). Aserce by
    // tedy praskla na změně korpusu, ne na vadě. Vlastnost, o kterou tu jde, je
    // užší a platí bez ohledu na sadu: co se neaplikovalo, nemá dosah.
    for (const id of ids) {
      const body = await edit(id);
      if (body.outcome === 'CERTIFIED') continue;
      expect(body.applied, `${id}: odmítnutá `.concat('sim se přesto aplikovala')).not.toContain('sim');
      const simLeaves = body.changedLeaves.filter((leaf) => leaf === '/sim' || leaf.startsWith('/sim/'));
      expect(simLeaves, `${id}: odmítnutá `.concat('sim vykázala dosah')).toEqual([]);
      if (!body.applied.includes('look'))
        expect(body.changedLeaves, `${id}: nic se neaplikovalo, dosah přesto není prázdný`).toEqual([]);
    }
  });
});

describe('hranice požadavku', () => {
  it('nevalidní vstup vrátí 400 se strukturovaným tělem', async () => {
    const world = baseDoc('C02');

    const noPrompt = await post({ worldDoc: world, baseRevision: { sim: 0, look: 0 } });
    expect(noPrompt.status).toBe(400);
    expect((noPrompt.body.error as { field: string }).field).toBe('promptId');

    // `baseRevision` musí být **dvojice** — jedno číslo by znamenalo, že se obě
    // části posuzují proti téže revizi, a to je přesně vada, kterou §13.1.1 řeší.
    const oneNumber = await post({ worldDoc: world, baseRevision: 0, promptId: 'E01' });
    expect(oneNumber.status).toBe(400);
    expect((oneNumber.body.error as { field: string }).field).toBe('baseRevision');

    const halfPair = await post({ worldDoc: world, baseRevision: { sim: 0 }, promptId: 'E01' });
    expect(halfPair.status).toBe(400);

    const notADoc = await post({ worldDoc: { nope: true }, baseRevision: { sim: 0, look: 0 }, promptId: 'E01' });
    expect(notADoc.status).toBe(400);
    expect((notADoc.body.error as { code: string }).code).toBe('INVALID_WORLD_DOC');
  });

  it('dokument s přepsanou `sim` a starým hashem se dovnitř nedostane', async () => {
    // `migrateWorldDoc` je jediný vstup pro čtení dokumentu právě proto, že
    // ověří i `simHash`. Bez toho by šlo poslat svět, který se tváří jako
    // zmrazený, a nechat si na něj vydat patch autorovaný pro jiný.
    const world = baseDoc('C02');
    const tampered = { ...world, sim: { ...world.sim, entities: { ghost: { role: 'prop' } } } };
    const response = await post({
      worldDoc: tampered,
      baseRevision: { sim: world.simRevision, look: world.lookRevision },
      promptId: 'E01',
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('INVALID_WORLD_DOC');
    expect((response.body.error as { message: string }).message).toContain('simHash');
  });

  it('patch pro jiný svět je 404 nad dvojicí, ne tiše aplikovaný patch', async () => {
    // Oracle úlohy povoluje jako double *„upstream jen záznamem vázaným na
    // dvojici (svět, prompt)"*. `E01` je autorovaný proti `C02`; proti `C01` pro
    // něj zmrazený záznam neexistuje, i když obojí je platný svět.
    const other = baseDoc('C01');
    const response = await post({
      worldDoc: other,
      baseRevision: { sim: other.simRevision, look: other.lookRevision },
      promptId: 'E01',
    });
    expect(response.status).toBe(404);
    expect((response.body.error as { code: string }).code).toBe('UNKNOWN_PAIR');
  });

  it('svět se shodným `simHash`, ale jiným obsahem, vazbu neprojde', async () => {
    // **Regrese na nález brány nad `f7e153c`, reprodukovaný end-to-end.**
    //
    // Vazba záznamu na svět se původně ověřovala `simHash`em, tedy FNV-1a-32 —
    // osmi hex znaky. To je otisk pro replay, ne autentizace: 32 bitů se nehledá
    // štěstím, hledá se výpočtem. Padělek níž je **skutečný**, ne teoretický:
    // z `C02` se změní `state.timers.flood.durationTicks` (přesně ten list, který
    // edituje `E01`) a do `witness` přibude výplňový klíč. `canonical` řadí klíče,
    // takže se výplň hashuje jako poslední a prefix se počítá jen jednou —
    // sedmiznakový řetězec `cem6xgv` se našel za 32 sekund.
    //
    // `migrateWorldDoc` proti tomu nepomůže a nemá jak: ověřuje, že `simHash`
    // sedí na svou vlastní `sim`, a to má padělatel plně ve své moci. Dokud vazba
    // četla `simHash`, endpoint tenhle svět přijal jako `C02` a vrátil
    // `CERTIFIED` — tedy měřil editaci proti světu, který si zvolil volající.
    //
    // Hodnoty jsou tu jako **data**, ne jako výpočet: kolize se hledala jednou.
    // Kdyby se hledala v testu, sada by na tři desítky sekund běhu doplácela při
    // každém spuštění a při změně korpusu by tiše přestala hledat cokoli.
    const source = baseDoc('C02');
    const forged = structuredClone(source) as WorldDoc;
    const timers = (forged.sim as { state: { timers: { flood: { durationTicks: number } } } }).state.timers;
    timers.flood.durationTicks = 9;
    (forged.sim as { witness: Record<string, unknown> }).witness.zz = 'cem6xgv';

    // Předpoklady testu — obojí musí platit, jinak by aserce níž neměřila nic.
    const sealed = sealSimHash(forged) as WorldDoc;
    expect(sealed.simHash, 'kolize se rozpadla — padělek už nemá `simHash` jako `C02`').toBe(source.simHash);
    expect(JSON.stringify(sealed.sim), 'padělek se neliší obsahem, takže není padělek').not.toBe(
      JSON.stringify(source.sim),
    );

    const response = await post({
      worldDoc: sealed,
      baseRevision: { sim: sealed.simRevision, look: sealed.lookRevision },
      promptId: 'E01',
    });
    expect(response.status, 'endpoint přijal podvržený svět jako `C02`').toBe(404);
    expect((response.body.error as { code: string }).code).toBe('UNKNOWN_PAIR');
  });

  it('create prompt tudy neprojde — druhá větev je `/api/emit`', async () => {
    const world = baseDoc('C01');
    for (const id of ['C01', 'E99']) {
      const response = await post({
        worldDoc: world,
        baseRevision: { sim: world.simRevision, look: world.lookRevision },
        promptId: id,
      });
      expect(response.status, `${id} nesmí projít jako editační prompt`).toBe(404);
      expect((response.body.error as { code: string }).code).toBe('UNKNOWN_PROMPT');
    }
  });
});
