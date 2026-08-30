/**
 * Testy meshovače a jeho workeru.
 *
 * ## Co se dá v Node dokázat a co ne
 *
 * `vitest` běží bez prohlížeče, takže **skutečné běhání mimo hlavní vlákno**
 * tady dokázat nejde — to je práce `e2e/mesh-budget.spec.ts` ve vlně 1 T5, kde
 * je prohlížeč a měří se zamrznutí snímku. Tady se dokazuje to, co z toho
 * plyne strukturálně: klient **sám od sebe nikdy nepočítá na volajícím
 * vlákně**, a odpověď workeru nese přesně ty tři buffery, jejichž vlastnictví
 * se má předat.
 *
 * Rozdíl je podstatný. Tichý ústup na hlavní vlákno je nejdražší možná vada:
 * v testu i na vývojářském stroji všechno funguje a zamrzne to až porotci.
 */

import { describe, expect, it, vi } from 'vitest';

import { createMeshClient, type MeshWorkerLike } from '../mesh-client';
import { handleMeshJob, type MeshJobRequest, type MeshJobResponse } from '../mesh-worker';
import { meshShapeProgram, paddedBounds, type ShapeMesh } from '../surface-nets';
import type { Bounds3, ShapeNode, ShapeProgram } from '../types';

const SEED = 20260829;

const UNIT_BOUNDS: Bounds3 = { min: [-2, -2, -2], max: [2, 2, 2] };

const SPHERE: readonly ShapeNode[] = [{ kind: 'sphere', radius: 1 }];

/**
 * Platný program kolem podané tabulky.
 *
 * Obálka je tu celá schválně: od brány ve workeru (30. 8. 2026) není `nodes` +
 * `root` platný program, a test, který by si obálku odpustil, by bránu měřil
 * proti vstupu, jaký produkt nikdy nepošle.
 */
function programOf(nodes: readonly ShapeNode[]): ShapeProgram {
  return {
    shapeId: 'test-shape',
    stableId: 'test-object',
    nodes,
    root: nodes.length - 1,
    targetBounds: UNIT_BOUNDS,
    anchors: [],
    materialIntent: 'clay',
    priority: 0,
  };
}

function meshOf(nodes: readonly ShapeNode[], resolution: number, bounds = UNIT_BOUNDS): ShapeMesh {
  return meshShapeProgram(programOf(nodes), SEED, { resolution, bounds });
}

/**
 * Kolikrát se v meshi objeví každá neorientovaná hrana.
 *
 * Uzavřené těleso má **každou hranu právě dvakrát**. Jednou znamená díru,
 * třikrát a víc znamená, že se tam sešly plochy, které se sejít neměly.
 */
function edgeUseCounts(indices: Uint32Array): Map<string, number> {
  const counts = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const corners = [indices[t], indices[t + 1], indices[t + 2]];
    for (let e = 0; e < 3; e += 1) {
      const a = corners[e];
      const b = corners[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * 1. Koule je uzavřená, má správné rozměry a jednotkové normály.
 * ------------------------------------------------------------------ */

describe('surface nets nad koulí', () => {
  const resolution = 32;
  const bounds = paddedBounds(UNIT_BOUNDS, resolution);
  const mesh = meshShapeProgram(programOf(SPHERE), SEED, { resolution, bounds });

  it('vyrobí neprázdný mesh', () => {
    expect(mesh.vertexCount).toBeGreaterThan(500);
    expect(mesh.triangleCount).toBeGreaterThan(1000);
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
  });

  it('je uzavřený — každá hrana patří přesně dvěma trojúhelníkům', () => {
    const counts = edgeUseCounts(mesh.indices);
    const wrong = [...counts.values()].filter((count) => count !== 2);
    expect(wrong.length, `${wrong.length} hran mimo dvojici`).toBe(0);
  });

  it('rozměry sedí v toleranci 1,5 buňky', () => {
    const cell = (bounds.max[0] - bounds.min[0]) / resolution;
    for (const axis of [0, 1, 2] as const) {
      expect(Math.abs(mesh.bounds.min[axis] - -1)).toBeLessThan(1.5 * cell);
      expect(Math.abs(mesh.bounds.max[axis] - 1)).toBeLessThan(1.5 * cell);
    }
  });

  it('normály jsou jednotkové a míří ven', () => {
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      const nx = mesh.normals[v * 3];
      const ny = mesh.normals[v * 3 + 1];
      const nz = mesh.normals[v * 3 + 2];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);

      // Na kouli se středem v počátku je normála ven totéž co směr od středu.
      const px = mesh.positions[v * 3];
      const py = mesh.positions[v * 3 + 1];
      const pz = mesh.positions[v * 3 + 2];
      const radial = Math.hypot(px, py, pz);
      expect((nx * px + ny * py + nz * pz) / radial).toBeGreaterThan(0.9);
    }
  });

  it('vinutí trojúhelníků souhlasí s normálou z pole', () => {
    // Obrácené vinutí dá mesh, který zevnitř vypadá plný a zvenku zmizí. Je to
    // vada, kterou test na uzavřenost nechytí — hrany sedí v obou orientacích.
    let agreeing = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      const ax = mesh.positions[a * 3];
      const ay = mesh.positions[a * 3 + 1];
      const az = mesh.positions[a * 3 + 2];
      const ux = mesh.positions[b * 3] - ax;
      const uy = mesh.positions[b * 3 + 1] - ay;
      const uz = mesh.positions[b * 3 + 2] - az;
      const vx = mesh.positions[c * 3] - ax;
      const vy = mesh.positions[c * 3 + 1] - ay;
      const vz = mesh.positions[c * 3 + 2] - az;

      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;

      const dot = fx * mesh.normals[a * 3] + fy * mesh.normals[a * 3 + 1] + fz * mesh.normals[a * 3 + 2];
      if (dot > 0) agreeing += 1;
    }
    expect(agreeing / mesh.triangleCount).toBeGreaterThan(0.99);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Jemnější mřížka je týž tvar, jen ostřejší — na tom stojí hot-swap.
 * ------------------------------------------------------------------ */

describe('rozlišení mění hustotu, ne tvar', () => {
  it('víc buněk znamená víc trojúhelníků nad týmž kvádrem', () => {
    const coarse = meshOf(SPHERE, 16, paddedBounds(UNIT_BOUNDS, 16));
    const fine = meshOf(SPHERE, 40, paddedBounds(UNIT_BOUNDS, 40));

    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount * 3);
    for (const axis of [0, 1, 2] as const) {
      // Jemnější mřížka trefí povrch přesněji, takže se rozměry mají přiblížit
      // jedničce, ne od ní utéct.
      expect(Math.abs(fine.bounds.max[axis] - 1)).toBeLessThanOrEqual(
        Math.abs(coarse.bounds.max[axis] - 1) + 1e-6,
      );
    }
  });

  it('tentýž vstup dá bitově tentýž mesh', () => {
    const a = meshOf(SPHERE, 20);
    const b = meshOf(SPHERE, 20);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});

/* ------------------------------------------------------------------ *
 * 3. Rozbít to schválně.
 * ------------------------------------------------------------------ */

describe('meshovač nespadne na okrajových zadáních', () => {
  it('tvar mimo zadaný kvádr dá prázdný mesh, ne výjimku', () => {
    const mesh = meshShapeProgram(
      programOf([
        { kind: 'sphere', radius: 0.5 },
        { kind: 'translate', child: 0, offset: [40, 0, 0] },
      ]),
      SEED,
      { resolution: 16, bounds: UNIT_BOUNDS },
    );
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.triangleCount).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });

  it('kvádr celý uvnitř tělesa dá taky prázdný mesh', () => {
    // Žádná buňka nemění znaménko, takže povrch v tom výřezu není. Prázdno je
    // správná odpověď — chybou by bylo mřížku vyplnit trojúhelníky.
    const mesh = meshShapeProgram(programOf([{ kind: 'sphere', radius: 50 }]), SEED, {
      resolution: 12,
      bounds: UNIT_BOUNDS,
    });
    expect(mesh.vertexCount).toBe(0);
  });

  it('tvar, který o vlásek přeteče svůj kvádr, bez rezervy zmizí', () => {
    // Nejhorší možný konec: těleso vyplní celou mřížku vzorků, žádná buňka
    // nemění znaménko a meshovač poctivě vrátí prázdno. Objekt se nerozbije —
    // on **není**, a nikde není ani chyba. `targetBounds` píše model odhadem,
    // takže tenhle případ není teoretický.
    const tight: Bounds3 = { min: [-1, -1, -1], max: [1, 1, 1] };
    const overflowing: readonly ShapeNode[] = [{ kind: 'box', size: [2.000002, 2.000002, 2.000002] }];

    expect(meshOf(overflowing, 24, tight).triangleCount).toBe(0);
    expect(meshOf(overflowing, 24, paddedBounds(tight, 24)).triangleCount).toBeGreaterThan(6000);
  });

  it('koule přetékající o vlásek má bez rezervy volné hrany, s rezervou ne', () => {
    const tight: Bounds3 = { min: [-1, -1, -1], max: [1, 1, 1] };
    const overflowing: readonly ShapeNode[] = [{ kind: 'sphere', radius: 1.000001 }];

    const openEdges = (mesh: ShapeMesh) =>
      [...edgeUseCounts(mesh.indices).values()].filter((count) => count !== 2).length;

    expect(openEdges(meshOf(overflowing, 24, tight))).toBeGreaterThan(0);
    expect(openEdges(meshOf(overflowing, 24, paddedBounds(tight, 24)))).toBe(0);
  });

  it('program s NaN-ovým uzlem dá mesh, ne prázdnou scénu', () => {
    // Rovina s nulovou normálou je nejlevnější zdroj NaN. Bez pojistky ve
    // `field.ts` by `Math.min` roznesl NaN do celé mřížky a mesh by zmizel.
    const mesh = meshOf(
      [
        { kind: 'plane', normal: [0, 0, 0], offset: 0 },
        { kind: 'sphere', radius: 1 },
        { kind: 'union', children: [0, 1] },
      ],
      20,
    );
    expect(mesh.vertexCount).toBeGreaterThan(100);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Worker: čistá funkce a seznam přenosů.
 * ------------------------------------------------------------------ */

describe('worker vrací mesh a předává vlastnictví paměti', () => {
  const request: MeshJobRequest = {
    jobId: 'job-1',
    program: programOf(SPHERE),
    sessionSeed: SEED,
    resolution: 20,
    bounds: paddedBounds(UNIT_BOUNDS, 20),
  };

  it('odpověď nese tři buffery, a jsou to právě ty tři z meshe', () => {
    const { response, transfer } = handleMeshJob(request);
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    expect(transfer).toHaveLength(3);
    // Kopie místo přenosu je zhruba megabajt navíc a pauza na obou vláknech.
    expect(transfer).toContain(response.positions.buffer);
    expect(transfer).toContain(response.normals.buffer);
    expect(transfer).toContain(response.indices.buffer);
    // Tři různé buffery, ne třikrát tentýž — společný buffer by se po přenosu
    // odpojil a zbylá dvě pole by byla prázdná.
    expect(new Set(transfer).size).toBe(3);
  });

  it('výjimka uvnitř se vrátí jako odpověď, ne jako pád workeru', () => {
    // Pád by vzal s sebou i tvary, které čekají ve frontě za tímhle.
    //
    // Mřížka o hraně 100 000 je 1e15 vzorků, tedy alokace, kterou žádný stroj
    // neunese. Je to jediná cesta k `catch`, která zbyla poté, co se před něj
    // postavila brána — a je to cesta **reálná**: `resolution` posílá volající,
    // brána programu na něj nedosáhne.
    const { response, transfer } = handleMeshJob({ ...request, resolution: 100_000 });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.jobId).toBe('job-1');
    expect(response.error.length).toBeGreaterThan(0);
    expect(transfer).toHaveLength(0);
  });

  it('měří vlastní čas, aby se rozpočty vlny 1 pinovaly na naměřené', () => {
    const { response } = handleMeshJob(request);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4b. Brána workeru: neplatný program se odmítne s důvodem, ne pádem.
 * ------------------------------------------------------------------ */

/**
 * Vlastnost, kterou tenhle blok chrání: **z odpovědi na neplatný program se dá
 * ten program opravit.**
 *
 * Není to totéž co „worker nespadl". Do 30. 8. 2026 worker nepadal, protože
 * `catch` chytal všechno — jenže vracel
 * `TypeError: Cannot read properties of undefined (reading 'kind')`, což je
 * hláška o `field.ts`, ne o programu. Od vlny 2 píše programy model a tahle
 * odpověď je jeho jediná zpětná vazba; věta o `undefined` mu neřekne, co
 * přepsat. Aserce proto míří na **obsah důvodu**, ne na jeho délku.
 */
describe('brána workeru odmítne neplatný program s důvodem', () => {
  const base = {
    jobId: 'gated',
    sessionSeed: SEED,
    resolution: 12,
    bounds: paddedBounds(UNIT_BOUNDS, 12),
  };

  function refuse(program: ShapeProgram): string {
    const { response, transfer } = handleMeshJob({ ...base, program });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('gate let an invalid program through');
    // Odmítnutá práce nesmí nabídnout k přenosu **žádnou** paměť. `postMessage`
    // uvedený buffer odpojí, takže buffer v seznamu u odpovědi, která ho
    // neposílá, je odpojená paměť, kterou pak nikdo nevlastní.
    //
    // Pozor, co tahle aserce **nedokazuje**: že se nemeshovalo. Pád uprostřed
    // meshingu skončí v `catch` a vrátí prázdný seznam taky. Že brána stojí
    // před polem, je vidět na hlášce, ne tady.
    expect(transfer).toHaveLength(0);
    return response.error;
  }

  it('kořen mimo tabulku pojmenuje řádek i velikost tabulky', () => {
    // Přesně ta mutace z 29. 8. 2026, která nález odhalila.
    const reason = refuse({ ...programOf(SPHERE), root: 3 });
    expect(reason).toContain('root references node 3 outside the table of 1');
    // Hláška z `field.ts` je ta vada, kterou tahle brána nahrazuje.
    expect(reason).not.toContain('Cannot read properties of undefined');
  });

  it('uzel odkazující mimo tabulku se pozná taky', () => {
    const reason = refuse(
      programOf([{ kind: 'sphere', radius: 1 }, { kind: 'translate', child: 5, offset: [1, 0, 0] }]),
    );
    // **Odmítnutí nese `outside the table`, a jenom to** — od opravy nálezu
    // `T7-gate-deadcheck` (30. 8. 2026) jsou obě hlášky vzájemně výlučné.
    // Předtím se tenhle program odmítal větou „at or above itself", protože se
    // pořadí ptalo obráceně a hláška o tabulce se u potomka neozvala nikdy.
    // Aserce na pouhé `references node 5` by byla ozdobná: sedla by na obě
    // hlášky a nepoznala by, kterou z nich brána doopravdy vydala.
    expect(reason).toContain('node 1 references node 5 outside the table of 2');
    expect(reason).not.toContain('at or above itself');
  });

  it('soudí se celý program, ne jen tabulka uzlů', () => {
    // Tenhle případ je důvod, proč `MeshOrder` nese celý program: plochý
    // `targetBounds` je vada obálky a ořezaný `Pick` by na ni nedosáhl.
    //
    // Pozor na to, co `targetBounds` **není**: mřížkuje se podle `request.bounds`,
    // což je jiné pole, a brána na něj nedosáhne vůbec. `targetBounds` je kvádr,
    // do kterého potrubí hotový tvar normalizuje.
    const reason = refuse({
      ...programOf(SPHERE),
      targetBounds: { min: [-1, 2, -1], max: [1, 2, 1] },
    });
    expect(reason).toContain('targetBounds is flat or inverted');
  });

  it('platný program branou projde', () => {
    // Bez tohohle by branou prošlo i „odmítej všechno".
    const { response } = handleMeshJob({ ...base, program: programOf(SPHERE) });
    expect(response.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4c. Práce, ze které nic nevyleze, je selhání — ne úspěch s prázdnem.
 * ------------------------------------------------------------------ */

/**
 * Vlastnost: **objednaný tvar, který na plátně není, se pozná tady a ne až
 * okem.**
 *
 * Naměřeno 30. 8. 2026: platný program s plochým `bounds` i s `resolution: 0`
 * vracel `ok: true` a nula trojúhelníků. Slib se splnil, počítadlo hotových
 * tvarů se zvýšilo a nekreslilo se nic — „zmizelý hrdina", tedy ta třída
 * selhání, kvůli které existuje `paddedBounds`.
 *
 * Dvě poloviny, obě potřeba: zadání se soudí **před** prací, aby vada mřížky
 * měla vlastní jméno, a výsledek **po** ní, protože cest k prázdnu je víc, než
 * jde vyjmenovat.
 */
describe('prázdná práce se vrací jako selhání', () => {
  const base = {
    jobId: 'empty',
    sessionSeed: SEED,
    resolution: 12,
    bounds: paddedBounds(UNIT_BOUNDS, 12),
    program: programOf(SPHERE),
  };

  function refuse(request: MeshJobRequest): string {
    const { response, transfer } = handleMeshJob(request);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('an empty job was reported as success');
    expect(transfer).toHaveLength(0);
    return response.error;
  }

  it('plochý kvádr se pozná před prací a jmenuje osu', () => {
    const reason = refuse({ ...base, bounds: { min: [-2, 2, -2], max: [2, 2, 2] } });
    expect(reason).toContain('invalid mesh request');
    // Osa v hlášce je to, co dělá rozdíl mezi opravitelným a neopravitelným
    // důvodem: „něco je špatně s kvádrem" model nikam neposune.
    expect(reason).toContain('bounds on y are flat or inverted');
  });

  it('obrácený kvádr propadne toutéž kontrolou', () => {
    const reason = refuse({ ...base, bounds: { min: [2, -2, -2], max: [-2, 2, 2] } });
    expect(reason).toContain('bounds on x are flat or inverted');
  });

  it('mřížka pod jedničkou se pozná taky', () => {
    expect(refuse({ ...base, resolution: 0 })).toContain(
      'resolution 0 is not a whole number of at least 1',
    );
    expect(refuse({ ...base, resolution: 12.5 })).toContain('resolution 12.5 is not a whole number');
  });

  it('tvar mimo kvádr projde zadáním a spadne až na výsledku', () => {
    // Tohle je ta cesta, kterou kontrola vstupu chytit nemůže: zadání je
    // v pořádku po všech stránkách, jen je koule jinde než výřez.
    const reason = refuse({
      ...base,
      program: programOf([
        { kind: 'sphere', radius: 0.5 },
        { kind: 'translate', child: 0, offset: [40, 0, 0] },
      ]),
    });
    expect(reason).toContain('empty mesh');
  });

  it('kvádr celý uvnitř tělesa taky', () => {
    // Druhá polovina téhož: povrch existuje, jen ne uvnitř výřezu. Přesně
    // případ, který `paddedBounds` popisuje jako „objekt se nerozbije, on není".
    const reason = refuse({ ...base, program: programOf([{ kind: 'sphere', radius: 50 }]) });
    expect(reason).toContain('empty mesh');
  });

  it('poctivá práce zůstane úspěchem', () => {
    // Bez tohohle by celý blok prošel i s „odmítej všechno".
    const { response } = handleMeshJob(base);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.triangleCount).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Klient: fronta, chyby a zákaz tichého ústupu.
 * ------------------------------------------------------------------ */

/** Atrapa workeru — odpovídá až na vyzvání, aby šlo zkoumat frontu. */
function fakeWorker(): MeshWorkerLike & { queue: MeshJobRequest[]; flush(): void } {
  const queue: MeshJobRequest[] = [];
  const worker: MeshWorkerLike & { queue: MeshJobRequest[]; flush(): void } = {
    queue,
    onmessage: null,
    onerror: null,
    postMessage(message) {
      queue.push(message);
    },
    terminate: vi.fn(),
    flush() {
      const next = queue.shift();
      if (next === undefined) return;
      const { response } = handleMeshJob(next);
      worker.onmessage?.({ data: response });
    },
  };
  return worker;
}

describe('klient meshovacího workeru', () => {
  const order = {
    program: { ...programOf(SPHERE), shapeId: 'hero' },
    sessionSeed: SEED,
    resolution: 16,
    bounds: paddedBounds(UNIT_BOUNDS, 16),
  };

  it('pošle práci workeru a vrátí hotový mesh', async () => {
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });

    const promise = client.mesh(order);
    expect(worker.queue).toHaveLength(1);
    worker.flush();

    const result = await promise;
    expect(result.shapeId).toBe('hero');
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(client.pending).toBe(0);
  });

  it('drží pořadí a pouští jednu práci po druhé', async () => {
    // Souběh by hotový tvar doručil dřív, jenže `priority` v programu říká, co
    // má porotce vidět první — pořadí je tady vlastnost produktu.
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });

    const first = client.mesh(order);
    const second = client.mesh({ ...order, program: { ...order.program, shapeId: 'second' } });

    expect(worker.queue).toHaveLength(1);
    expect(client.pending).toBe(2);

    worker.flush();
    await first;
    expect(worker.queue).toHaveLength(1);
    worker.flush();
    expect((await second).shapeId).toBe('second');
  });

  it('chybu z workeru překlopí na odmítnutý slib', async () => {
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });
    const promise = client.mesh(order);

    const failure: MeshJobResponse = {
      jobId: worker.queue[0].jobId,
      ok: false,
      error: 'shape program is broken',
    };
    worker.queue.shift();
    worker.onmessage?.({ data: failure });

    await expect(promise).rejects.toThrow('shape program is broken');
  });

  it('bez workeru selže, místo aby tiše počítal na volajícím vlákně', async () => {
    // Tohle je ta nejdražší vada, které se dá předejít jedním `if`: v testu
    // i na vývojářském stroji všechno funguje a zamrzne to až porotci.
    const client = createMeshClient({
      createWorker: undefined,
      allowMainThread: false,
    });
    // V Node `Worker` z prohlížeče není, takže se klient dostane přesně sem.
    await expect(client.mesh(order)).rejects.toThrow(/mesh worker unavailable/);
  });

  it('ústup na hlavní vlákno jde vynutit, když si o něj někdo řekne', async () => {
    const client = createMeshClient({ allowMainThread: true });
    const result = await client.mesh(order);
    expect(result.triangleCount).toBeGreaterThan(0);
  });

  it('dispose odmítne i to, co ještě čeká ve frontě', async () => {
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });
    const running = client.mesh(order);
    const waiting = client.mesh(order);

    client.dispose();

    await expect(running).rejects.toThrow('mesh client is disposed');
    await expect(waiting).rejects.toThrow('mesh client is disposed');
    expect(worker.terminate).toHaveBeenCalled();
  });
});
