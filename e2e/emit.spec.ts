/**
 * `POST /api/emit` — oracle úlohy T13.
 *
 * Testuje se **běžící produkční server** (`next build` + `next start`), ne
 * zavolaná funkce. Rozdíl není formální: route má vlastní runtime (`nodejs`),
 * vlastní serializaci a čte zmrazený korpus přes `process.cwd()`. Kdyby se
 * volala přímo, prošlo by i potrubí, které se z `next start` nedá spustit.
 *
 * **Žádný `page.route`.** Zmrazený korpus je jediný povolený double a je až za
 * hranicí (`src/model/client.ts` proti `MANIFEST.lock`). Odchycení `/api/emit`
 * v testu by udělalo z oracle sebe sama — AC to proto zakazuje doslova a tenhle
 * soubor používá `request` fixture, která přes stránku vůbec nejde.
 *
 * **Oracle nečte tutéž cestu jako implementace.** Text promptu se sem načítá
 * přímo z `evals/frozen/prompts.v1.jsonl`, ne přes `frozenPrompt()`; verdikt se
 * počítá znovu z vráceného dokumentu přes `buildRuntimeWorld` + `verifyWitness`,
 * ne z `certificate` v odpovědi. Kdyby obojí četlo touž funkci, test by dokázal
 * jen to, že se implementace shoduje sama se sebou — tatáž vada, kvůli které
 * vznikl bod (2) AC T8b.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { buildRuntimeWorld } from '../src/ir/build';
import { simHashOf, validateLook, worldDocSchema } from '../src/ir/worlddoc';
import type { TraceInput } from '../src/sim/interpreter';
import { verifyWitness, type VerifiableWorld } from '../src/verify/witness';

interface EmitResponse {
  readonly requestId: string;
  readonly promptId: string;
  readonly outcome: 'CERTIFIED' | 'REJECTED' | 'NO_FIT';
  readonly upstream: { readonly model: string; readonly system: string; readonly user: string };
  readonly provenance: { readonly source: string; readonly synthetic: boolean; readonly bodySha256: string };
  readonly certificate?: { readonly verdict: string; readonly snapshotHash: string };
  readonly rejection: { readonly stage: string; readonly reason: string; readonly detail: string } | null;
  readonly doc: Record<string, unknown> | null;
  /** Oloupaný dokument tak, jak přišel. Na 200 je vždycky — i u odmítnutí. */
  readonly emission: Record<string, unknown> | null;
  readonly annotations: Record<string, unknown>;
}

/** Zmrazený text promptu — čtený nezávisle na `src/model/`. */
function frozenPromptText(id: string): string {
  const record = readFileSync('evals/frozen/prompts.v1.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string; prompt: string })
    .find((entry) => entry.id === id);
  if (record === undefined) throw new Error(`frozen prompt ${id} is missing — the corpus moved under the test`);
  return record.prompt;
}

async function emit(request: APIRequestContext, promptId: string): Promise<EmitResponse> {
  const response = await request.post('/api/emit', { data: { promptId } });
  expect(response.status(), `emit ${promptId} musí odpovědět 200 s verdiktem`).toBe(200);
  return (await response.json()) as EmitResponse;
}

/** Znovu složí běhový svět z **vráceného** dokumentu a ověří jeho svědka. */
function replay(doc: Record<string, unknown>): { world: VerifiableWorld; witness: readonly TraceInput[] } {
  const built = buildRuntimeWorld(doc.sim);
  expect(built.ok, 'vrácený `sim` se nedal znovu snížit — endpoint vydal něco jiného, než co certifikoval').toBe(
    true,
  );
  if (!built.ok) throw new Error(built.reason);
  return { world: built.world, witness: built.world.trace as readonly TraceInput[] };
}

test('vydá dvoudílný dokument s oběma revizemi, který projde schématem i verifikátorem', async ({ request }) => {
  const body = await emit(request, 'C01');

  expect(body.outcome).toBe('CERTIFIED');
  expect(body.rejection).toBeNull();
  expect(body.doc).not.toBeNull();
  const doc = body.doc!;

  // Schéma, kterým se dokument řídí, ne to, o kterém tvrdí, že jím prošel.
  const parsed = worldDocSchema.safeParse(doc);
  expect(parsed.error?.issues ?? [], 'vrácený dokument neprošel reálným schématem').toEqual([]);

  // Dvě části a **dvě nezávislá pole** revizí — §13.1.1. Jedna společná revize by
  // prošla asercí na přítomnost, proto se ptáme na oba klíče zvlášť.
  expect(Object.keys(doc).sort()).toEqual(
    ['irVersion', 'look', 'lookRevision', 'sim', 'simHash', 'simRevision'].sort(),
  );
  expect(typeof doc.simRevision).toBe('number');
  expect(typeof doc.lookRevision).toBe('number');

  // `look` prošlý schématem **a** kontrolou konečnosti všech číselných hodnot.
  const look = validateLook(doc.look);
  expect(look.issues).toEqual([]);
  expect(look.ok).toBe(true);

  // Hash pečetí systém ze `sim`; kdyby ho endpoint jen opsal z těla modelu,
  // dokument by si prohlásil identitu vlastní části sám.
  expect(doc.simHash).toBe(simHashOf(doc as { sim: unknown }));

  // Verifikátor spuštěný znovu, nad vráceným dokumentem — ne přečtený certifikát.
  const { world, witness } = replay(doc);
  const verdict = verifyWitness(world, witness);
  expect(verdict.verdict).toBe('CERTIFIED');
  expect(body.certificate).toEqual(verdict);
});

test('zaznamenaný upstream požadavek nese text promptu', async ({ request }) => {
  const body = await emit(request, 'C01');

  expect(body.upstream.user).toContain(frozenPromptText('C01'));
  // Bez tohohle by prošel i požadavek, který text nese, ale odpověď z něj
  // nevznikla: provenience říká, že jde o zmrazený syntetický záznam, a to je
  // jediné, co v Phase 3 smí odpověď vydat.
  expect(body.provenance.synthetic).toBe(true);
  expect(body.provenance.source).toBe('frozen-manifest');
});

test('dva prompty dají světy, které se liší chováním — svědek jednoho ve druhém doběhne a nevyhraje', async ({
  request,
}) => {
  // **Dvojice není libovolná a nesmí se měnit bez přeměření.** `C04` (truhla,
  // která jde otevřít jen s pochodní z vedlejší místnosti) a `C07` (pochodní,
  // co za dvě minuty dohoří) sdílejí dost jmen na to, aby byl svědek `C04`
  // ve světě `C07` celý **přípustný** — odmítne ho až vyčerpaný horizont.
  //
  // Na tom celý test stojí. Kterákoli jiná dvojice ze zmrazené sady padá na
  // `STEP_UNREACHABLE` v kroku 0, tedy dřív, než se vůbec zavolá `step()` —
  // to by dokazovalo neshodu **jmen**, ne rozdíl **chování**, a prošly by i dva
  // světy s bajtově shodnými pravidly a přejmenovanými sokety. Review v2
  // (Q2/T12) žádá behaviorální rozdíl, ne jiný hash; `NO_WIN` je ten rozdíl.
  const [a, b] = await Promise.all([emit(request, 'C04'), emit(request, 'C07')]);
  expect([a.outcome, b.outcome]).toEqual(['CERTIFIED', 'CERTIFIED']);

  const worldA = replay(a.doc!);
  const worldB = replay(b.doc!);

  // Kontrola polarity **první**: kdyby verifikátor odmítal cokoli, křížový test
  // by prošel a nedokazoval nic.
  expect(verifyWitness(worldA.world, worldA.witness).verdict).toBe('CERTIFIED');
  expect(verifyWitness(worldB.world, worldB.witness).verdict).toBe('CERTIFIED');

  const crossed = verifyWitness(worldB.world, worldA.witness);
  expect(crossed.verdict).toBe('REJECTED');
  // `reason` je tady tvrdší aserce než `verdict`: přesně tohle brání testu tiše
  // zdegenerovat na měření jmen, kdyby se korpus nebo rozpouštění cílů pohnulo.
  expect(crossed.verdict === 'REJECTED' && crossed.reason).toBe('NO_WIN');
  expect(crossed.verdict === 'REJECTED' && crossed.reason).not.toBe('STEP_UNREACHABLE');

  // Opačný směr je slabší důkaz (padá na dosažitelnosti) a je tu jen proto, aby
  // se nedalo tvrdit, že se světy liší jen v jednom směru. Neopírá se o něj nic.
  expect(verifyWitness(worldA.world, worldB.witness).verdict).toBe('REJECTED');
});

test('odmítnutí se vztahuje na `sim`, nikdy na scénu', async ({ request }) => {
  // §13.4 platí pro **všechna** odmítnutí, ne jen pro `NO_FIT`. Trojice pokrývá
  // tři různé cesty, jak se dá o `sim` přijít, a u všech tří musí zůstat scéna:
  // `C14` deklarované `NO_FIT`, `C12` systémový default po odmítnutí před
  // modelem, `C13` ořez na deklarovanou mez. Dokud endpoint u posledních dvou
  // vracel `doc: null` a nic víc, přišly o `look` i o entity, ze kterých se
  // skórují jejich vlastní zmrazené požadavky.
  for (const id of ['C14', 'C12', 'C13']) {
    const body = await emit(request, id);
    expect(body.emission, `${id} přišel o emisi`).not.toBeNull();
    expect(validateLook(body.emission!.look).issues, `${id} přišel o scénu`).toEqual([]);
  }

  // `NO_FIT` je vlastní verdikt, ne vada schématu — a říká to anotace obálky.
  const declined = await emit(request, 'C14');
  expect(declined.outcome).toBe('NO_FIT');
  expect(declined.rejection?.stage).toBe('declined');
  expect(declined.rejection?.reason).toBe('NO_FIT_DECLARED');
  expect(declined.annotations.simOutcome).toBe('NO_FIT');
  expect(declined.emission!.sim).toBeNull();
  // Anotace v dokumentu nezůstává a `doc` nevzniká — není co pečetit.
  expect(declined.emission).not.toHaveProperty('simOutcome');
  expect(declined.doc).toBeNull();

  // Anotaci píše potrubí, ne model — a taky se loupe, ne validuje jako pole.
  const clamped = await emit(request, 'C13');
  expect(clamped.annotations.clampedFrom).toBe(10_000);
  expect(clamped.emission).not.toHaveProperty('clampedFrom');
});

test('naměřené odmítnutí je 200 s verdiktem a s atribucí, ne 5xx', async ({ request }) => {
  // Tohle je rozdíl, který má celý P1 změřit: vadný svět není spadlé potrubí.
  // Kdyby endpoint vracel 5xx, měřicí běh v T17 by ty dvě věci nerozeznal.
  const witnessFails = await emit(request, 'C08');
  expect(witnessFails.outcome).toBe('REJECTED');
  expect(witnessFails.rejection?.stage).toBe('witness');
  expect(witnessFails.doc).not.toBeNull();

  // Jiná fáze, jiná atribuce: `C05` je mez naší reprezentace (`world-ir-v1`
  // neumí sčítat), ne vada emise. Scorer v T16 na tom rozdílu stojí.
  const cannotLower = await emit(request, 'C05');
  expect(cannotLower.outcome).toBe('REJECTED');
  expect(cannotLower.rejection?.stage).toBe('lowering');
  expect(cannotLower.rejection?.reason).toBe('UNSUPPORTED_SURFACE');
});

test('nevalidní vstup vrátí 400 se strukturovaným tělem', async ({ request }) => {
  const missing = await request.post('/api/emit', { data: {} });
  expect(missing.status()).toBe(400);
  const missingBody = (await missing.json()) as { requestId: string; error: { code: string; field: string } };
  expect(missingBody.error.code).toBe('INVALID_REQUEST');
  expect(missingBody.error.field).toBe('promptId');
  expect(missingBody.requestId).toMatch(/^[0-9a-f-]{36}$/);

  // `Buffer`, ne `string`: řetězec s hlavičkou `application/json` Playwright
  // sám zabalí do JSON (`"promptId=C01"`), takže by dorazilo **platné** JSON
  // a odpověď by byla `INVALID_REQUEST`. Rozbité tělo se dá poslat jen po
  // bajtech — jinak by tenhle případ tiše měřil tentýž kód jako ten nad ním.
  const notJson = await request.post('/api/emit', {
    data: Buffer.from('{ promptId: C01', 'utf8'),
    headers: { 'content-type': 'application/json' },
  });
  expect(notJson.status()).toBe(400);
  expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe('MALFORMED_BODY');

  // A ten výše zmíněný případ nahlas: platné JSON, které není objekt, je
  // `INVALID_REQUEST`, ne pád serveru na `null.promptId`.
  const notObject = await request.post('/api/emit', {
    data: Buffer.from('"C01"', 'utf8'),
    headers: { 'content-type': 'application/json' },
  });
  expect(notObject.status()).toBe(400);
  expect(((await notObject.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
});

test('tělo přes strop se odmítne a spojení zůstane použitelné', async ({ request }) => {
  // Route handlery App Routeru vlastní strop nemají a `next.config.mjs` žádný
  // nenastavuje, takže bez kontroly by se libovolně velký POST celý načetl dřív,
  // než se kdokoli podívá na `promptId`. Legální požadavek je jedno krátké id.
  const oversized = await request.post('/api/emit', {
    data: Buffer.alloc(200 * 1024, 0x61),
    headers: { 'content-type': 'application/json' },
  });
  expect(oversized.status()).toBe(413);
  expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');

  // **Druhá půlka je ta důležitá a je to regrese na naměřenou vadu.** První
  // znění stropu zbytek těla `cancel()`-ovalo. Nepřečtený zbytek zůstal na
  // keep-alive spojení, server ho začal číst jako začátek dalšího požadavku, a
  // následující **velký** požadavek uvízl až do timeoutu (krátký prošel, což to
  // maskovalo). Zároveň je to kontrola polarity: se stropem 0 by tahle aserce
  // padla, takže test nemůže projít s endpointem, který neodpovídá nikomu.
  const after = await request.post('/api/emit', {
    data: { promptId: 'C01', padding: 'x'.repeat(32 * 1024) },
  });
  expect(after.status()).toBe(200);
  expect(((await after.json()) as { outcome: string }).outcome).toBe('CERTIFIED');
});

test('neznámý prompt je 404, ne 400 a ne vymyšlený svět', async ({ request }) => {
  // Editační prompt existuje, ale tenhle endpoint emituje celý svět — druhá
  // větev je T14. Kdyby ho vzal, měřil by editaci tvorbou.
  for (const id of ['C99', 'E01']) {
    const response = await request.post('/api/emit', { data: { promptId: id } });
    expect(response.status(), `${id} nesmí projít jako create prompt`).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('UNKNOWN_PROMPT');
  }
});
