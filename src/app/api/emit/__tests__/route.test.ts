/**
 * `POST /api/emit` nad **celou** zmrazenou create sadou.
 *
 * Oracle úlohy je e2e sada proti běžícímu `next start`; tahle je vedle ní
 * a má jiný úkol — **pokrýt všech 15 promptů**, ne jednu reprezentativní cestu.
 * Brána nad `5b36a41` našla přesně tu díru: e2e jelo na 7 z 15 a obě zbylé vady
 * ležely v té nepokryté polovině. Route navíc neměla jedinou unit sadu, takže se
 * atribuce `rejection.stage` — to jediné, co z ní konzumuje scorer v T16 —
 * neověřovala nikde.
 *
 * **Aserce jsou třídní, ne jmenovité.** První oprava obálky ošetřila `C14`
 * a `C15` jmenovitě a nechala `C12` a `C13` spadnout na tomtéž; proto se tady
 * ptáme na vlastnost, která má platit pro každý záznam sady, a teprve pak na
 * pinovanou mapu výsledků.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_REQUESTS_PER_WINDOW, resetRateWindows, takeRateSlot } from '../../../../server/rate-limit';

import { ENVELOPE_ANNOTATIONS, simHashOf, validateLook, worldDocSchema } from '../../../../ir/worlddoc';
import { MAX_BODY_BYTES, POST, readBody } from '../route';

interface FrozenContract {
  readonly id: string;
  readonly kind: string;
  readonly scoreAs: string;
  readonly requirements: readonly { readonly rid: string; readonly kind: string }[];
}

interface EmitBody {
  readonly outcome: 'CERTIFIED' | 'REJECTED' | 'NO_FIT';
  readonly rejection: { readonly stage: string; readonly reason: string; readonly detail: string } | null;
  readonly doc: Record<string, unknown> | null;
  readonly emission: Record<string, unknown> | null;
  readonly annotations: Record<string, unknown>;
}

const contracts: FrozenContract[] = readFileSync('evals/frozen/contracts.v1.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as FrozenContract)
  .filter((contract) => contract.kind === 'create');

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(
    new Request('http://127.0.0.1/api/emit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function emit(promptId: string): Promise<EmitBody> {
  const response = await post({ promptId });
  expect(response.status, `${promptId} musí odpovědět 200 s verdiktem`).toBe(200);
  return response.body as unknown as EmitBody;
}

/** Všech 15 najednou — sada se čte z kontraktů, ne z ručního seznamu. */
const ids = contracts.map((contract) => contract.id);


/**
 * **Strop na frekvenci se před každým případem nuluje, a není to obcházení
 * meze.** Okna `takeRateSlot()` jsou proces-globální (`src/server/rate-limit.ts`)
 * a tahle sada vystřelí na jedny dveře víc než `MAX_REQUESTS_PER_WINDOW`
 * požadavků za desetisekundové okno — což žádný člověk neudělá, ale sada ano.
 * Bez tohohle řádku začne od padesátého prvního požadavku odpovídat 429 a
 * červená se objeví na náhodném případu podle pořadí, ne na tom vadném.
 */
beforeEach(() => {
  resetRateWindows();
});

describe('celá zmrazená create sada projde endpointem', () => {
  it('má právě 15 create promptů a žádný z nich nekončí 5xx', async () => {
    expect(ids.length).toBe(15);
    for (const id of ids) {
      const body = await emit(id);
      expect(['CERTIFIED', 'REJECTED', 'NO_FIT'], `${id}`).toContain(body.outcome);
    }
  });

  it('odmítnutí se vztahuje na `sim`, nikdy na scénu — `look` přežije každý verdikt', async () => {
    // §13.4 / `look.emptyScreenRule`: *„`NO_FIT` a necertifikovaný patch se
    // vztahují VÝHRADNĚ na `sim`"*. Tohle je ta aserce, kterou by `C12` ani
    // `C13` neprošly, dokud odmítnutí na schématu vracelo `doc: null` a nic víc.
    for (const id of ids) {
      const body = await emit(id);
      expect(body.emission, `${id} přišel o emisi`).not.toBeNull();
      const look = validateLook(body.emission!.look);
      expect(look.issues, `${id} přišel o scénu`).toEqual([]);
    }
  });

  it('anotace obálky se oloupou a do dokumentu se nedostanou', async () => {
    // Kdo kterou píše, je v `ENVELOPE_ANNOTATIONS`. Tady jde o to, že je endpoint
    // odděluje **všechny**, ne dvě jmenovitě.
    const seen = new Map<string, unknown>();
    for (const id of ids) {
      const body = await emit(id);
      for (const name of ENVELOPE_ANNOTATIONS) {
        expect(body.emission, `${id}: anotace ${name} zůstala v dokumentu`).not.toHaveProperty(name);
        if (Object.hasOwn(body.annotations, name)) seen.set(name, body.annotations[name]);
      }
    }

    // Každá deklarovaná anotace se ve zmrazené sadě opravdu vyskytuje — jinak by
    // seznam mohl obsahovat mrtvé jméno a nikdo by si toho nevšiml.
    expect([...seen.keys()].sort()).toEqual([...ENVELOPE_ANNOTATIONS].sort());
    expect(seen.get('simOutcome')).toBe('NO_FIT');
    expect(seen.get('refusedBeforeModel')).toBe(true);
    expect(seen.get('clampedFrom')).toBe(10_000);
  });

  it('obálka nepovoluje nic navíc — neznámé pole je pořád vada schématu', async () => {
    // Polarita seznamu. Bez toho by „oloupej anotace" šlo splnit i tím, že se
    // propustí cokoli, a `.strict()` by přestalo znamenat cokoli.
    const { peelEnvelope, worldEmissionSchema } = await import('../../../../ir/worlddoc');
    const source = await emit('C01');
    const peeled = peelEnvelope({ ...source.emission, somethingElse: 1 })!;
    expect(peeled.annotations).toEqual({});
    expect(worldEmissionSchema.safeParse(peeled.document).success).toBe(false);
  });

  it('pinovaná mapa výsledků a jejich atribuce', async () => {
    // Naměřeno, ne zvoleno — a pinuje se **stage**, protože právě na ní stojí
    // scorer z T16. Když se pokrytí pohne, čísla se rozejdou a je to vidět.
    const measured: Record<string, string> = {};
    for (const id of ids) {
      const body = await emit(id);
      measured[id] = body.rejection === null ? body.outcome : `${body.outcome}:${body.rejection.stage}`;
    }

    expect(measured).toEqual({
      C01: 'CERTIFIED',
      C02: 'CERTIFIED',
      C03: 'CERTIFIED',
      C04: 'CERTIFIED',
      // Mez naší reprezentace, ne vada emise — `world-ir-v1` neumí sčítat přes
      // zónu složenou z víc obdélníků. Rozpor se zmrazeným `FULFILLED` je
      // zapsaný v plánu u T13 a rozhoduje se před T17.
      C05: 'REJECTED:lowering',
      C06: 'CERTIFIED',
      C07: 'CERTIFIED',
      C08: 'REJECTED:witness',
      C09: 'REJECTED:witness',
      C10: 'REJECTED:witness',
      C11: 'REJECTED:witness',
      // Prázdný prompt: systémový default projde celým řetězcem a nevyhraje.
      // Dokud se `refusedBeforeModel` neloupalo, končil na `schema` bez scény.
      C12: 'REJECTED:witness',
      // `sim.entityCap` není v zmrazeném seznamu polí `sim` a `sim` je uvnitř
      // hashe, takže odmítnutí je správně. Scéna i entity jedou v `emission`.
      C13: 'REJECTED:schema',
      C14: 'NO_FIT:declined',
      C15: 'NO_FIT:declined',
    });
  });

  it('zapečetěný `doc` vzniká právě tam, kde dokument prošel schématem', async () => {
    for (const id of ids) {
      const body = await emit(id);
      const sealedExpected = body.outcome !== 'NO_FIT' && body.rejection?.stage !== 'schema';
      expect(body.doc !== null, `${id}: doc`).toBe(sealedExpected);
      if (body.doc === null) continue;

      // Hash pečetí systém ze `sim`, ne model. A dokument je celý, ne půlka.
      expect(body.doc.simHash).toBe(simHashOf(body.doc as { sim: unknown }));
      expect(worldDocSchema.safeParse(body.doc).error?.issues ?? [], `${id}`).toEqual([]);
    }
  });

  it('data, na která se ptá kontrakt, jsou v odpovědi dosažitelná', async () => {
    // Tohle je ta vazba, která chyběla: endpoint se měří proti **zmrazeným
    // kontraktům**, ne proti vlastní představě o tom, co je užitečné vrátit.
    // `sceneMustBuild` se skóruje z `look`, `minEntitiesByRole` ze `sim.entities` —
    // a obojí musí přežít i verdikt, který dokument odmítl.
    for (const contract of contracts) {
      const body = await emit(contract.id);
      for (const requirement of contract.requirements) {
        if (requirement.kind === 'sceneMustBuild')
          expect(body.emission?.look, `${requirement.rid}`).toBeDefined();
        if (requirement.kind === 'minEntitiesByRole') {
          const sim = body.emission?.sim as { entities?: Record<string, unknown> } | null;
          expect(Object.keys(sim?.entities ?? {}).length, `${requirement.rid}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('čtení těla je ohraničené velikostí i časem', () => {
  /**
   * Pošle `prefixBytes` a pak **navždy mlčí**, aniž by stream zavřel.
   *
   * Tohle je ten klient z nálezu: zůstane pod stropem, takže velikostní mez se
   * neuplatní nikdy, a jediné, co ho může utnout, jsou hodiny.
   */
  function stalling(prefixBytes: number): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          if (prefixBytes > 0) controller.enqueue(new Uint8Array(prefixBytes));
          return undefined;
        }
        // Nikdy se nedokončí — `read()` tedy visí, přesně jako na síti.
        return new Promise<void>(() => undefined);
      },
    });
  }

  /** Stream, který sype dál a dál. Přeteče dřív, než dojdou hodiny. */
  function flooding(chunkBytes: number): ReadableStream<Uint8Array> {
    return new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
  }

  function streamed(body: ReadableStream<Uint8Array>): Request {
    return new Request('http://127.0.0.1/api/emit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // Node vyžaduje duplex u těla, které je stream.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  }

  it('nekonečný stream POD stropem skončí na deadlinu, ne až na timeoutu Node', async () => {
    // **Tohle je ta půlka, kterou první verze deadlinu neuměla.** Armovala ho až
    // při přetečení, takže 1 kB kusy do nezavřeného streamu deadline nikdy
    // nenaarmovaly a handler visel do výchozích 300 s `requestTimeout`.
    const started = Date.now();
    const read = await readBody(streamed(stalling(1024)), 60);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('mlčící stream skončí taky — deadline neběží na kusech, ale na hodinách', async () => {
    const read = await readBody(streamed(stalling(0)), 60);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toBe('TIMEOUT');
  });

  it('stream NAD stropem se odliší jako `TOO_LARGE`, ne `TIMEOUT`', async () => {
    // Dvě různé příčiny, dva různé kódy: 413 mluví o velikosti, 408 o čase.
    // Kdyby splynuly, klient přes strop by dostal radu „zkus to pomaleji".
    const read = await readBody(streamed(flooding(MAX_BODY_BYTES + 1)), 60);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toBe('TOO_LARGE');
  });

  it('legální tělo se o deadline neopře a projde celé', async () => {
    // Polarita. Bez ní by testy výš splnil i `readBody`, který odmítá vždycky.
    const read = await readBody(
      new Request('http://127.0.0.1/api/emit', { method: 'POST', body: '{"promptId":"C01"}' }),
      60,
    );
    expect(read.ok).toBe(true);
    expect(read.ok && read.text).toBe('{"promptId":"C01"}');
  });

  it('deadline je zapojený do `POST`, ne jen do pomocné funkce', async () => {
    // `readBody` se dá otestovat samo a pořád být v handleru odpojené. Tenhle
    // případ jede přes `POST` a s produkční hodnotou, takže platí i to spojení.
    const response = await POST(streamed(stalling(0)));
    expect(response.status).toBe(408);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BODY_TIMEOUT');
  }, 15_000);
});

describe('stavový kontrakt', () => {
  it('nevalidní vstup je 400, neznámý create prompt 404', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ promptId: '' })).status).toBe(400);
    expect((await post('C01')).status).toBe(400);
    // `E01` existuje, ale je editační — druhá větev je T14.
    for (const id of ['C99', 'E01']) expect((await post({ promptId: id })).status, id).toBe(404);
  });
});

describe('strop na frekvenci dorazí až ke dveřím', () => {
  it('padesátý první požadavek v okně je 429 s retry-after, ne 200', async () => {
    // Okno se plní přímo čítačem — měří se zapojení meze do těchhle dveří,
    // ne mez sama (`src/server/__tests__/rate-limit.test.ts`).
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1) takeRateSlot('emit');
    try {
      const response = await POST(
        new Request('http://127.0.0.1/api/emit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ promptId: 'C01' }),
        }),
      );
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'TOO_MANY_REQUESTS',
      );
    } finally {
      resetRateWindows();
    }
  });
});
