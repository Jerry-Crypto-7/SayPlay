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

import {
  MeshBudgetError,
  MeshEmptyError,
  createMeshClient,
  type MeshWorkerLike,
} from '../mesh-client';
import { validateShapeProgram } from '../schema';
import { handleMeshJob, judgeBudget, type MeshJobRequest, type MeshJobResponse } from '../mesh-worker';
import { meshShapeProgram, paddedBounds, type ShapeMesh } from '../surface-nets';
import { MESH_DETAIL, type Bounds3, type ShapeNode, type ShapeProgram } from '../types';

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
function programOf(nodes: readonly ShapeNode[], targetBounds: Bounds3 = UNIT_BOUNDS): ShapeProgram {
  return {
    shapeId: 'test-shape',
    stableId: 'test-object',
    nodes,
    root: nodes.length - 1,
    targetBounds,
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
    bounds: UNIT_BOUNDS,
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

  it('mesh nad stropem trojúhelníků se odmítne, i když program bránou prošel', () => {
    // Nález nezávislého review. Vstupní brána váží řádky, kopie a vyhodnocení
    // na buňku — povrch neváže žádné z nich. Tyhle **tři legální uzly** daly
    // v mřížce 48 přes 190 000 trojúhelníků: šestinásobek stropu tvaru
    // (32 000) a 1,6násobku rozpočtu celého světa (120 000).
    const bounds: Bounds3 = { min: [-1.2, -1.2, -1.2], max: [1.2, 1.2, 1.2] };
    const crinkled: readonly ShapeNode[] = [
      { kind: 'sphere', radius: 0.75 },
      { kind: 'displace', child: 0, amplitude: 0.35, frequency: 14, seed: 3 },
      { kind: 'displace', child: 1, amplitude: 0.2, frequency: 9, seed: 5 },
    ];
    const program = { ...programOf(crinkled), targetBounds: bounds };

    // Brána programu ho pustí — tohle je ten důvod, proč strop musí být na
    // výsledku. Kdyby ho odmítla, tenhle test by neměřil nic.
    expect(validateShapeProgram(program).ok).toBe(true);

    const { response, transfer } = handleMeshJob({
      jobId: 'job-fat',
      program,
      sessionSeed: SEED,
      resolution: MESH_DETAIL.high.resolution,
      bounds,
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    // Důvod jmenuje obě čísla, protože je vstupem sebeopravy modelu.
    expect(response.error).toMatch(
      new RegExp(`above maxTriangles ${MESH_DETAIL.high.maxTriangles}`),
    );
    expect(response.error).toMatch(/^mesh is \d+ triangles/);
    // **Příznak, ne věta.** Proxy na přetečený rozpočet odpovídá hrubší
    // mřížkou (`COARSER_GRIDS`); kdyby to poznávala podle textu hlášky,
    // vypnula by tu reakci první přeformulovaná věta pro porotce.
    expect(response.overBudget).toBe(true);
    expect(transfer).toHaveLength(0);
  });

  it('mesh pod stropem projde, takže strop neodmítá to, co produkt staví', () => {
    // Failure path té samé brány: kdyby se strop utáhl pod to, co produkt
    // doopravdy staví, přestal by stavět a tohle to řekne.
    //
    // **Komentář tu do 2. 9. 2026 tvrdil tři nepravdy naráz** a nálezla je
    // nezávislá revize: „nejtěžší z dvanácti ručních tvarů dá v mřížce 48
    // 26 992 trojúhelníků" — 26 992 nebyl tvar galerie, byl to **referenční
    // program**; s rezervou z `T13-meshpadding` je z něj **24 616**; a
    // nejtěžší tvar galerie v mřížce 48 je `vault` s **20 352**
    // (`evals/shape/gallery-cost.json`, 2. 9. 2026). Proti stropu 32 000 má
    // tedy produkt rezervu 36 %, ne 16 %.
    //
    // Aserce níž měří **kouli v mřížce 20**, ne nejtěžší tvar galerie, takže
    // sama o sobě strop nehlídá. Drží ji spolu s testem o kus výš, který
    // dokazuje druhou půlku — že přeplněný tvar strop **odmítne**.
    const { response } = handleMeshJob(request);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.triangleCount).toBeLessThanOrEqual(MESH_DETAIL.rough.maxTriangles);
  });

  it('mřížka 32³ je poslední hrubá příčka, ne první jemná', () => {
    // `budgetFor()` dělí příčky na `resolution <= 32`, a ta hranice se do
    // 9. 9. 2026 netestovala vůbec: testy žebříku vstřikují falešný mesher,
    // takže skutečný strop nikdy nikdo nepřekročil a mutace `<= 32` → `< 32`
    // (tedy 32³ souzené rozpočtem `high`) nechala celou sadu zelenou.
    //
    // **Zabít ji jde jen na 32³, a jen tvarem v úzkém pásu.** Mřížka 16 ten
    // rozdíl nevidí — 16 je pod 32 v obou zněních, takže obě vrátí `rough`;
    // AC nálezu žádalo právě 16³ a splnit se nedalo. Tvar musí padnout mezi
    // oba stropy: nad `rough` 16 000 a pod `high` 32 000, jinak ho odmítnou
    // obě znění, nebo ani jedno.
    //
    // Naměřeno 9. 9. 2026: tenhle program dá na 32³ **20 850 trojúhelníků**
    // za 34 ms. Trojúhelníky se soudí dřív než čas a 34 ms je i pod
    // `rough.maxMs` 350, takže odmítnutí nemůže přijít z druhého důvodu.
    const bounds: Bounds3 = { min: [-1.2, -1.2, -1.2], max: [1.2, 1.2, 1.2] };
    const middling: readonly ShapeNode[] = [
      { kind: 'sphere', radius: 0.75 },
      { kind: 'displace', child: 0, amplitude: 0.2, frequency: 10, seed: 3 },
      { kind: 'displace', child: 1, amplitude: 0.12, frequency: 7, seed: 5 },
    ];
    const program = { ...programOf(middling), targetBounds: bounds };
    expect(validateShapeProgram(program).ok).toBe(true);

    const job: MeshJobRequest = {
      jobId: 'job-rung',
      program,
      sessionSeed: SEED,
      resolution: MESH_DETAIL.rough.resolution,
      bounds,
    };

    // Nesouzeně: číslo, na kterém stojí celý test. Kdyby tvar z pásu vypadl,
    // obě aserce níž by platily z jiného důvodu, než tvrdí titulek.
    const measured = handleMeshJob({ ...job, unbudgeted: true }).response;
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.triangleCount).toBeGreaterThan(MESH_DETAIL.rough.maxTriangles);
    expect(measured.triangleCount).toBeLessThan(MESH_DETAIL.high.maxTriangles);

    // A souzeně: 32³ se soudí hrubou příčkou, takže tenhle tvar neprojde.
    const { response } = handleMeshJob(job);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.overBudget).toBe(true);
    expect(response.error).toContain(`above maxTriangles ${MESH_DETAIL.rough.maxTriangles}`);
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
    bounds: UNIT_BOUNDS,
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
    bounds: UNIT_BOUNDS,
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
    //
    // ⚠ **`targetBounds` se sem dopsalo 1. 9. 2026 a je to podstata testu, ne
    // formalita.** Do `T12-boundsratio` fixtura deklarovala jednotkový kvádr
    // a kouli 40 metrů od něj, takže program byl **sám v sobě rozporný** — od
    // té úlohy ho brána programu odmítne dřív, než se k meshingu dojde, a test
    // by měřil ji místo prázdného výsledku. Kvádr tvaru proto obepíná kouli
    // tam, kde doopravdy je; jinde než výřez je pořád, a přesně o tom to je.
    const reason = refuse({
      ...base,
      program: programOf(
        [
          { kind: 'sphere', radius: 0.5 },
          { kind: 'translate', child: 0, offset: [40, 0, 0] },
        ],
        { min: [39, -1, -1], max: [41, 1, 1] },
      ),
    });
    expect(reason).toContain('empty mesh');
  });

  it('kvádr celý uvnitř tělesa taky', () => {
    // Druhá polovina téhož: povrch existuje, jen ne uvnitř výřezu. Přesně
    // případ, který `paddedBounds` popisuje jako „objekt se nerozbije, on není".
    // `targetBounds` obepíná kouli ze stejného důvodu jako o test výš.
    const reason = refuse({
      ...base,
      program: programOf([{ kind: 'sphere', radius: 50 }], {
        min: [-50, -50, -50],
        max: [50, 50, 50],
      }),
    });
    expect(reason).toContain('empty mesh');
  });

  it('odmítnutí mimo rozpočet příznak `overBudget` nenese', () => {
    // Failure path příznaku, ne jeho happy path. Kdyby ho nesla každá
    // odmítnutá práce, proxy by na prázdný mesh i na vadné zadání spálila
    // celý žebřík mřížek a porotci pak napsala „went over budget on every
    // rung" o tvaru, který se rozpočtu ani nedotkl.
    const outside = handleMeshJob({
      ...base,
      program: programOf(
        [
          { kind: 'sphere', radius: 0.5 },
          { kind: 'translate', child: 0, offset: [40, 0, 0] },
        ],
        { min: [39, -1, -1], max: [41, 1, 1] },
      ),
    }).response;
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error).toContain('empty mesh');
    expect(outside.overBudget).toBeUndefined();

    const flat = handleMeshJob({ ...base, bounds: { min: [-2, 2, -2], max: [2, 2, 2] } }).response;
    expect(flat.ok).toBe(false);
    if (flat.ok) return;
    expect(flat.overBudget).toBeUndefined();
  });

  it('prázdný mesh nese příznak `emptyMesh`, vadné zadání ne', () => {
    // Happy i failure path druhého příznaku — `T14r-boundspad`. Proxy podle něj
    // sestoupí o příčku níž; kdyby ho nesla i vadná objednávka, spálil by se
    // celý žebřík na tvaru, kterému hrubší mřížka nemá co pomoct.
    const empty = handleMeshJob({
      ...base,
      program: programOf([{ kind: 'sphere', radius: 50 }], {
        min: [-50, -50, -50],
        max: [50, 50, 50],
      }),
    }).response;
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.emptyMesh).toBe(true);

    const flat = handleMeshJob({ ...base, bounds: { min: [-2, 2, -2], max: [2, 2, 2] } }).response;
    expect(flat.ok).toBe(false);
    if (flat.ok) return;
    expect(flat.emptyMesh).toBeUndefined();
  });

  it('tvar, kterému rezerva jedné buňky nestačí, se vymešuje o příčku níž', () => {
    // **Naměřený případ, ne vymyšlený.** `chessBoardShape` z případu c26
    // archivu `evals/worldstream/create-raw.json` — jediný ze 41 tvarů, které
    // projdou bránou schématu, který na první příčce vrátí prázdno.
    //
    // Proč: obruba je `roundBox` 3,5 × 0,24 × 3,5 s poloměrem 0,12, tedy sahá
    // v `x` do 1,87, kdežto `targetBounds` končí na 1,75. Rezerva na 32³ je
    // 3,5/32 = 0,109, takže kvádr se vzorkuje do 1,859 — pořád **uvnitř**
    // tělesa. Žádný vzorek nezmění znaménko a povrch nevznikne. Na 24³ je
    // rezerva 3,5/24 = 0,146, kvádr sahá do 1,896, roh je venku a tvar se
    // uzavře.
    //
    // Brána objemu ho propustí právem: poměr kvádrů je asi 1,15×, hluboko pod
    // prahem `MAX_BOUNDS_VOLUME_RATIO`. Přesah nad rezervu tedy **není** vada
    // programu, kterou by šlo odmítnout u vstupu.
    const chessBoard = programOf(
      [
        { kind: 'roundBox', size: [3.5, 0.24, 3.5], radius: 0.12 },
        { kind: 'box', size: [3.05, 0.18, 3.05] },
        { kind: 'translate', child: 1, offset: [0, 0.12, 0] },
        { kind: 'subtract', children: [0, 2] },
        { kind: 'roundBox', size: [3.02, 0.08, 3.02], radius: 0.04 },
        { kind: 'translate', child: 4, offset: [0, 0.1, 0] },
        { kind: 'union', children: [3, 5] },
      ],
      { min: [-1.75, -0.12, -1.75], max: [1.75, 0.16, 1.75] },
    );
    const order = { ...base, program: chessBoard, bounds: chessBoard.targetBounds };

    const rough = handleMeshJob({ ...order, resolution: 32 }).response;
    expect(rough.ok).toBe(false);
    if (rough.ok) return;
    expect(rough.emptyMesh).toBe(true);

    const coarser = handleMeshJob({ ...order, resolution: 24 }).response;
    expect(coarser.ok).toBe(true);
    if (!coarser.ok) return;
    expect(coarser.triangleCount).toBe(4232);
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
 * 4c-bis. Rezervu jedné buňky přidává worker, ne volající.
 * ------------------------------------------------------------------ */

/**
 * Vlastnost: **objednávka meshe prochází rezervou, takže tvar napsaný na svůj
 * vlastní obal nezmizí.**
 *
 * `paddedBounds()` existovala od 29. 8. 2026 i s naměřenou tabulkou v hlavičce
 * a do 2. 9. 2026 ji **nevolal ani jeden produkční volající** — `proxy.ts`,
 * `/gallery` i `/dev/mesh-budget` posílaly `targetBounds` syrově. Od
 * `T13-meshpadding` ji přidává `handleMeshJob()` každé objednávce.
 *
 * ## Co se při psaní testu naměřilo a co to opravuje v zadání úlohy
 *
 * Zadání říkalo „tvar, jehož `targetBounds` sedí **přesně** na jeho obalu,
 * vrátí neprázdný mesh". Naměřeno 2. 9. 2026: **přesný sed je v pořádku i bez
 * rezervy** — vzorek na hranici má vzdálenost přesně 0, a znaménko se soudí
 * `value < 0`, takže nula je „venku" a hranice se pořád mění. Kvádr `2³`
 * v mřížce 24 nad ⟨−1, 1⟩ dá s rezervou i bez ní 6 348 trojúhelníků.
 *
 * Mizí až **vlásečnicový přesah**: kvádr `2,000002³` má i krajní vzorek uvnitř,
 * žádná buňka nemění znaménko a meshovač poctivě vrátí prázdno. To je ta
 * třída, kterou rezerva zavírá, a je to táž třída, kterou popisuje tabulka
 * u `paddedBounds`.
 *
 * ## Proč je ten kvádr schovaný za `rotate`
 *
 * Bez obalu ho `T12-boundsratio` odmítne dřív, než se k meshingu vůbec dojde
 * (`shape overflows its own targetBounds`), a test by měřil bránu programu
 * místo rezervy. `rotate` je **dokumentovaný** důvod, proč je obal nejistý
 * (`certainHulls` v `types.ts`): ze samotného kvádru potomka skutečný obal
 * otočeného tvaru spočítat nejde. Deformace, pole, `intersect` a `subtract`
 * jsou na tom stejně — tudy chodí model, jehož `targetBounds` je odhad.
 */
describe('rezervu přidává worker, ne volající', () => {
  const TIGHT: Bounds3 = { min: [-1, -1, -1], max: [1, 1, 1] };
  const RESOLUTION = 24;

  /** Kvádr přetékající svůj obal o 1e-6, schovaný před bránou za `rotate`. */
  const HAIRLINE: readonly ShapeNode[] = [
    { kind: 'box', size: [2.000002, 2.000002, 2.000002] },
    { kind: 'rotate', child: 0, yaw: 0, pitch: 0, roll: 0 },
  ];

  function job(nodes: readonly ShapeNode[]): MeshJobRequest {
    return {
      jobId: 'padding',
      sessionSeed: SEED,
      resolution: RESOLUTION,
      bounds: TIGHT,
      program: programOf(nodes, TIGHT),
    };
  }

  function trianglesVia(nodes: readonly ShapeNode[]): number {
    const { response } = handleMeshJob(job(nodes));
    expect(response.ok, response.ok ? '' : response.error).toBe(true);
    if (!response.ok) throw new Error(response.error);
    return response.triangleCount;
  }

  it('vlásečnicový přesah bez rezervy zmizí celý — to je ta vada', () => {
    // Přímé volání meshovače je tady schválně: je to ta cesta, kterou produkt
    // šel do 2. 9. 2026, a bez ní by test netvrdil nic o tom, co se opravilo.
    const bare = meshShapeProgram(programOf(HAIRLINE, TIGHT), SEED, {
      resolution: RESOLUTION,
      bounds: TIGHT,
    });
    expect(bare.triangleCount).toBe(0);
  });

  it('objednávka přes worker ho vrátí neprázdný', () => {
    expect(trianglesVia(HAIRLINE)).toBe(6348);
  });

  it('rezerva je přesně `paddedBounds`, ne libovolné nafouknutí', () => {
    // Koule přesně na svém obalu ta dvě čísla rozejde: 5 244 bez rezervy proti
    // 4 620 s ní. Rovnost na obě strany zabije jak „worker nepadduje", tak
    // „padduje jinak než volající".
    //
    // Kvádr z testů výš by tady neposloužil — ten dá s rezervou i bez ní
    // 6 348, a rovnost by prošla i mutantovi, který nepadduje vůbec.
    const sphere = programOf(SPHERE, TIGHT);
    const bare = meshShapeProgram(sphere, SEED, { resolution: RESOLUTION, bounds: TIGHT });
    const padded = meshShapeProgram(sphere, SEED, {
      resolution: RESOLUTION,
      bounds: paddedBounds(TIGHT, RESOLUTION),
    });

    expect(bare.triangleCount).toBe(5244);
    expect(padded.triangleCount).toBe(4620);
    expect(trianglesVia(SPHERE)).toBe(padded.triangleCount);
  });

  it('rezerva se počítá z rozlišení objednávky, ne z konstanty', () => {
    // Buňka je `span / resolution`, takže jemnější mřížka má menší rezervu.
    // Bez tohohle by prošla i rezerva napevno o velikosti buňky mřížky 24.
    const fine = 40;
    const { response } = handleMeshJob({ ...job(SPHERE), resolution: fine });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const expected = meshShapeProgram(programOf(SPHERE, TIGHT), SEED, {
      resolution: fine,
      bounds: paddedBounds(TIGHT, fine),
    });
    expect(response.triangleCount).toBe(expected.triangleCount);
  });
});

/* ------------------------------------------------------------------ *
 * 4d. Měřit se dá i bez rozsudku — a nic jiného se tím nevypne.
 * ------------------------------------------------------------------ */

/**
 * Vlastnost: **měřidlo se nesmí soudit rozpočtem, který teprve měří.**
 *
 * Naměřeno 31. 8. 2026: `e2e/mesh-budget.spec.ts` byl červený od 29. 8. na
 * `mesh is 47680 triangles, above maxTriangles 32000 for resolution 64`.
 * Report vede 64³ a 96³ schválně **bez rozsudku**, jenže `budgetFor(64)` sáhne
 * po příčce `high`, tedy po stropu mřížky 48³ — a worker odmítl vlastní měření.
 * Šest dní se to nikdo nedozvěděl, protože značka `@measure` drží ten spec mimo
 * `npm run test:e2e`.
 *
 * Ty dveře jsou proto **jedny a úzké**: vypínají rozpočet a nic víc. Kdyby
 * vypnuly i bránu programu nebo prázdný mesh, měřilo by se něco, co produkt
 * nepostaví — a to je horší než neměřit vůbec.
 */
describe('nesouzená práce se změří, ale zbylé brány platí dál', () => {
  /** Tři legální uzly, které v mřížce 48 dají přes 190 000 trojúhelníků. */
  const CRINKLED: readonly ShapeNode[] = [
    { kind: 'sphere', radius: 0.75 },
    { kind: 'displace', child: 0, amplitude: 0.35, frequency: 14, seed: 3 },
    { kind: 'displace', child: 1, amplitude: 0.2, frequency: 9, seed: 5 },
  ];
  const FAT_BOUNDS: Bounds3 = { min: [-1.2, -1.2, -1.2], max: [1.2, 1.2, 1.2] };

  const fatJob: MeshJobRequest = {
    jobId: 'job-unbudgeted',
    program: { ...programOf(CRINKLED), targetBounds: FAT_BOUNDS },
    sessionSeed: SEED,
    resolution: MESH_DETAIL.high.resolution,
    bounds: FAT_BOUNDS,
  };

  it('týž mesh se souzený odmítne a nesouzený vrátí', () => {
    // Obě poloviny v jednom testu schválně: samotné „nesouzený projde" by
    // prošlo i tehdy, kdyby se rozpočet zrušil úplně.
    const judged = handleMeshJob(fatJob).response;
    expect(judged.ok).toBe(false);

    const measured = handleMeshJob({ ...fatJob, unbudgeted: true }).response;
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    // Nad stropem příčky `high`, jinak by tenhle test nedokazoval nic.
    expect(measured.triangleCount).toBeGreaterThan(MESH_DETAIL.high.maxTriangles);
  });

  it('nesouzený čas pokrývá meshing, takže sloupec reportu drží význam', () => {
    // **Tenhle test má dvě předchozí podoby a obě byly ozdobné** — nezávislá
    // revize je zabila dvěma mutacemi, které přežily: `elapsedMs = 0` na
    // nesouzené cestě, a `startedAt` posunuté až za `meshShapeProgram()`.
    // `toBeGreaterThanOrEqual(0)` platí pro jakýkoli rozdíl dvou `Date.now()`,
    // takže neměřilo nic. Ani `toBeGreaterThan(0)` by nestačilo: rozlišení
    // `Date.now()` je milisekunda a druhá mutace by se do ní občas vešla.
    //
    // Vlastnost, o kterou tu jde: `elapsedMs` **pokrývá tu drahou práci**, ne
    // úklid kolem ní. Report vedle sebe staví `workerMs` souzených
    // i nesouzených řádků a v obou sloupcích to musí být totéž číslo o tomtéž.
    // Měří se proto zvenčí a porovnává: čas uvnitř je většina času venku.
    const outerStart = Date.now();
    const { response } = handleMeshJob({ ...fatJob, unbudgeted: true });
    const outerMs = Date.now() - outerStart;

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    // Práce sama stojí stovky milisekund (190 000 trojúhelníků), takže dolní
    // hranice je volná a přesto o tři řády nad tím, co dá posunuté měření.
    expect(outerMs).toBeGreaterThan(20);
    expect(response.elapsedMs).toBeGreaterThan(outerMs / 2);
  });

  it('brána programu platí i bez rozpočtu', () => {
    const broken = {
      ...fatJob,
      unbudgeted: true,
      program: { ...programOf(SPHERE), root: 9 },
    };
    const { response } = handleMeshJob(broken);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toContain('invalid shape program');
  });

  it('vadné zadání i prázdný výsledek platí i bez rozpočtu', () => {
    const flat = handleMeshJob({
      ...fatJob,
      unbudgeted: true,
      bounds: { min: [-2, 2, -2], max: [2, 2, 2] },
    }).response;
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.error).toContain('invalid mesh request');

    const empty = handleMeshJob({
      ...fatJob,
      unbudgeted: true,
      // Kvádr tvaru obepíná kouli — viz `T12-boundsratio` o dva bloky výš.
      program: programOf([{ kind: 'sphere', radius: 50 }], {
        min: [-50, -50, -50],
        max: [50, 50, 50],
      }),
      bounds: UNIT_BOUNDS,
      resolution: 12,
    }).response;
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('empty mesh');
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
    onmessageerror: null,
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

/** Queue lifecycle tests do not benchmark the CPU mesher or its time budget. */
function completeQueueStub(worker: MeshWorkerLike & { queue: MeshJobRequest[] }) {
  const request = worker.queue.shift(); if (!request) throw new Error('no queued job');
  worker.onmessage?.({ data: { jobId: request.jobId, ok: true, positions: new Float32Array(9), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), vertexCount: 3, triangleCount: 1, bounds: UNIT_BOUNDS, elapsedMs: 1 } });
}

describe('klient meshovacího workeru', () => {
  const order = {
    program: { ...programOf(SPHERE), shapeId: 'hero' },
    sessionSeed: SEED,
    resolution: 16,
    bounds: UNIT_BOUNDS,
  };

  it('a late response cannot remove a newer running job', async () => {
    const worker = fakeWorker(); const client = createMeshClient({ createWorker: () => worker });
    const first = client.mesh(order); const oldId = worker.queue[0].jobId;
    completeQueueStub(worker); await first;
    const second = client.mesh(order);
    worker.onmessage?.({ data: { jobId: oldId, ok: false, error: 'late old reply' } });
    expect(client.pending).toBe(1);
    completeQueueStub(worker); await expect(second).resolves.toMatchObject({ shapeId: 'hero' });
    expect(client.pending).toBe(0); client.dispose();
  });

  it('cancels a running job, restarts the worker, and ignores the terminated worker', async () => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0;
    const client = createMeshClient({ createWorker: () => workers[index++] });
    const control = new AbortController();
    const first = client.mesh(order, control.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = client.mesh(order);
    control.abort(); await rejected;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(client.pending).toBe(1);
    completeQueueStub(workers[0]);
    expect(client.pending).toBe(1);
    completeQueueStub(workers[1]); await expect(second).resolves.toMatchObject({ shapeId: 'hero' });
    client.dispose();
  });

  it('bounds the queue and removes a cancelled queued job before dispatch', async () => {
    const worker = fakeWorker(); const client = createMeshClient({ createWorker: () => worker, maxPending: 2 });
    const first = client.mesh(order); const control = new AbortController();
    const queued = client.mesh(order, control.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.mesh(order)).rejects.toThrow('queue is full');
    control.abort(); await rejected;
    expect(client.pending).toBe(1);
    completeQueueStub(worker); await first;
    expect(worker.queue).toHaveLength(0); client.dispose();
  });

  it('messageerror rejects the running job and completes queued work on a fresh worker', async () => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0;
    const client = createMeshClient({ createWorker: () => workers[index++] });
    const first = client.mesh(order);
    const rejected = expect(first).rejects.toThrow('mesh worker response could not be deserialized');
    const second = client.mesh({ ...order, program: { ...order.program, shapeId: 'after-messageerror' } });
    expect(client.pending).toBe(2);
    expect(workers[0].queue).toHaveLength(1);
    workers[0].onmessageerror?.({ type: 'messageerror' });
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(index).toBe(2);
    expect(workers[1].queue).toHaveLength(1);
    expect(client.pending).toBe(1);
    completeQueueStub(workers[1]);
    await expect(second).resolves.toMatchObject({ shapeId: 'after-messageerror' });
    expect(client.pending).toBe(0);
    client.dispose();
  });

  it('registers messageerror with EventTarget when a worker has no native handler property', async () => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0;
    const listeners: ((event: unknown) => void)[] = [];
    const nativeLike = Object.assign(workers[0], { addEventListener: vi.fn((type: 'messageerror', listener: (event: unknown) => void) => {
      expect(type).toBe('messageerror'); listeners.push(listener);
    }) });
    delete nativeLike.onmessageerror;
    const client = createMeshClient({ createWorker: () => workers[index++] });
    const first = client.mesh(order), rejected = expect(first).rejects.toThrow('could not be deserialized');
    const second = client.mesh({ ...order, program: { ...order.program, shapeId: 'event-target-recovery' } });
    expect(nativeLike.addEventListener).toHaveBeenCalledTimes(1);
    expect('onmessageerror' in nativeLike).toBe(false);
    listeners[0]({ type: 'messageerror' }); await rejected;
    expect(index).toBe(2); expect(client.pending).toBe(1);
    // Already queued delivery still cannot affect the replacement's job.
    listeners[0]({ type: 'messageerror' });
    expect(workers[1].terminate).not.toHaveBeenCalled();
    completeQueueStub(workers[1]); await expect(second).resolves.toMatchObject({ shapeId: 'event-target-recovery' });
    expect(client.pending).toBe(0); client.dispose();
  });

  it('EventTarget listener delivery during cancellation retirement cannot settle or orphan queued work', async () => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0, listener: ((event: unknown) => void) | undefined;
    Object.assign(workers[0], { addEventListener: (_type: 'messageerror', callback: (event: unknown) => void) => { listener = callback; } });
    workers[0].terminate = vi.fn(() => listener?.({ type: 'messageerror' }));
    const client = createMeshClient({ createWorker: () => workers[index++] }), control = new AbortController();
    const first = client.mesh(order, control.signal), rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = client.mesh(order); control.abort(); await rejected;
    expect(index).toBe(2); expect(workers[0].terminate).toHaveBeenCalledTimes(1); expect(client.pending).toBe(1);
    completeQueueStub(workers[1]); await expect(second).resolves.toMatchObject({ shapeId: 'hero' }); client.dispose();
  });

  it('retires the aborted worker before terminate can deliver a synchronous response', async () => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0;
    const client = createMeshClient({ createWorker: () => workers[index++] });
    const control = new AbortController();
    const first = client.mesh(order, control.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = client.mesh({ ...order, program: { ...order.program, shapeId: 'replacement' } });
    workers[0].terminate = vi.fn(() => {
      completeQueueStub(workers[0]);
      workers[0].onerror?.(new Error('during terminate'));
      workers[0].onmessageerror?.({ type: 'messageerror' });
    });
    control.abort();
    await rejected;
    expect(index).toBe(2);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[1].terminate).not.toHaveBeenCalled();
    expect(client.pending).toBe(1);
    completeQueueStub(workers[1]);
    await expect(second).resolves.toMatchObject({ shapeId: 'replacement' });
    expect(client.pending).toBe(0);
    client.dispose();
  });

  it('disposal rejects running and queued work despite a synchronous terminate response', async () => {
    const worker = fakeWorker(); const factory = vi.fn(() => worker);
    const client = createMeshClient({ createWorker: factory });
    const first = client.mesh(order); const second = client.mesh(order);
    const firstRejected = expect(first).rejects.toThrow('mesh client is disposed');
    const secondRejected = expect(second).rejects.toThrow('mesh client is disposed');
    worker.terminate = vi.fn(() => completeQueueStub(worker));
    client.dispose();
    await Promise.all([firstRejected, secondRejected]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(client.pending).toBe(0);
  });

  it('a synchronous postMessage failure cannot reenter termination and orphan the next job', async () => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0;
    const client = createMeshClient({ createWorker: () => workers[index++] });
    const post = workers[0].postMessage.bind(workers[0]);
    workers[0].postMessage = request => {
      if (request.program.shapeId === 'broken') throw new Error('structured clone failed');
      post(request);
    };
    const first = client.mesh(order);
    const broken = client.mesh({ ...order, program: { ...order.program, shapeId: 'broken' } });
    const rejected = expect(broken).rejects.toThrow('structured clone failed');
    const third = client.mesh({ ...order, program: { ...order.program, shapeId: 'after-failure' } });
    let delivered = false;
    workers[0].terminate = vi.fn(() => {
      if (delivered) return;
      delivered = true;
      workers[0].onmessageerror?.({ type: 'messageerror' });
    });
    completeQueueStub(workers[0]);
    await first; await rejected;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(index).toBe(2);
    expect(client.pending).toBe(1);
    expect(workers[1].queue).toHaveLength(1);
    completeQueueStub(workers[1]);
    await expect(third).resolves.toMatchObject({ shapeId: 'after-failure' });
    expect(client.pending).toBe(0);
    client.dispose();
  });

  it.each(['failed', 'cancelled'])('ignores a late messageerror from a %s worker', async kind => {
    const workers = [fakeWorker(), fakeWorker()]; let index = 0;
    const client = createMeshClient({ createWorker: () => workers[index++] });
    const control = new AbortController();
    const first = client.mesh(order, control.signal);
    const rejected = expect(first).rejects.toBeInstanceOf(Error);
    const second = client.mesh({ ...order, program: { ...order.program, shapeId: 'replacement' } });
    // Capture the callback as the browser may have already queued delivery.
    const late = workers[0].onmessageerror;
    expect(late).toBeTypeOf('function');
    if (kind === 'failed') workers[0].onerror?.(new Error('original failure'));
    else control.abort();
    await rejected;
    late?.({ type: 'messageerror' });
    workers[0].onerror?.(new Error('late old error'));
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[1].terminate).not.toHaveBeenCalled();
    expect(index).toBe(2);
    expect(client.pending).toBe(1);
    completeQueueStub(workers[1]);
    await expect(second).resolves.toMatchObject({ shapeId: 'replacement' });
    expect(client.pending).toBe(0);
    client.dispose();
  });

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
    await expect(promise).rejects.not.toBeInstanceOf(MeshBudgetError);
  });

  it('odmítnutí na rozpočtu překlopí na vlastní třídu, ostatní ne', async () => {
    // Tohle je jediné místo, kde se příznak workeru mění na něco, na co umí
    // volající reagovat. Kdyby se ztratil tady, proxy by hrubší mřížku
    // nikdy neobjednala a osm světů by se vrátilo na krabici — beze slova.
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });
    const promise = client.mesh(order);

    const failure: MeshJobResponse = {
      jobId: worker.queue[0].jobId,
      ok: false,
      error: 'mesh is 17200 triangles, above maxTriangles 16000 for resolution 32',
      overBudget: true,
    };
    worker.queue.shift();
    worker.onmessage?.({ data: failure });

    await expect(promise).rejects.toBeInstanceOf(MeshBudgetError);
    await expect(promise).rejects.toThrow('above maxTriangles 16000');
  });

  it('prázdný mesh překlopí na vlastní třídu, protože se na něj taky reaguje', async () => {
    // Druhý příznak, na který proxy odpovídá sestupem — `T14r-boundspad`.
    // Rezerva workeru je jedna buňka, tedy `1/resolution` kvádru, takže hrubší
    // příčka jí rezervuje víc a tvar, který svou krabici přeteče o kousek víc
    // než jednu buňku, se do ní na 24³ vejde. Kdyby se příznak ztratil tady,
    // sestup by se nikdy neobjednal.
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });
    const promise = client.mesh(order);

    const failure: MeshJobResponse = {
      jobId: worker.queue[0].jobId,
      ok: false,
      error: 'empty mesh: no surface inside the requested box',
      emptyMesh: true,
    };
    worker.queue.shift();
    worker.onmessage?.({ data: failure });

    await expect(promise).rejects.toBeInstanceOf(MeshEmptyError);
    await expect(promise).rejects.not.toBeInstanceOf(MeshBudgetError);
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

  it('výchozí klient posílá práci k rozsudku, ne k pouhému změření', async () => {
    // `unbudgeted` se vypisuje vždycky, i když je `false` — jinak by se tenhle
    // test musel spokojit s „pole tam není", což je slabší tvrzení.
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker });

    const promise = client.mesh(order);
    expect(worker.queue[0].unbudgeted).toBe(false);
    worker.flush();

    expect((await promise).triangleCount).toBeGreaterThan(0);
  });

  it('měřicí klient si o nesouzenou práci řekne', async () => {
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker, unbudgeted: true });

    const promise = client.mesh(order);
    expect(worker.queue).toHaveLength(1);
    expect(worker.queue[0].unbudgeted).toBe(true);
    worker.flush();

    expect((await promise).triangleCount).toBeGreaterThan(0);
  });

  it('bez workeru selže i měřicí klient, místo aby ustoupil na hlavní vlákno', async () => {
    // **Tenhle test vznikl proto, že mutace přežila.** První podoba předchozího
    // testu dosazovala atrapu workeru, takže se k ústupovému `if` nedostala —
    // a `unbudgeted` směl klidně znamenat i `allowMainThread`, aniž by se něco
    // ozvalo. `unbudgeted` je volba **o rozsudku**, ne o vlákně: kdyby měřidlo
    // spadlo na hlavní vlákno, `workerMs` v reportu by u části řádků přestalo
    // znamenat „čas ve workeru" a sloupec by se tiše rozešel sám se sebou.
    const client = createMeshClient({ createWorker: undefined, unbudgeted: true });
    await expect(client.mesh(order)).rejects.toThrow(/mesh worker unavailable/);
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

  it.each(['construction', 'postMessage'])('synchronous %s failure releases the queue and permits retry', async mode => {
    const worker = fakeWorker();
    let attempts = 0;
    const client = createMeshClient({ createWorker: () => {
      attempts++;
      if (attempts === 1) {
        if (mode === 'construction') throw new Error('cannot create worker');
        return { ...worker, postMessage: () => { throw new Error('cannot clone request'); } };
      }
      return worker;
    } });
    await expect(client.mesh(order)).rejects.toThrow(/cannot/);
    expect(client.pending).toBe(0);
    const retry = client.mesh(order);
    completeQueueStub(worker);
    await expect(retry).resolves.toMatchObject({ shapeId: order.program.shapeId });
    expect(client.pending).toBe(0);
    client.dispose();
  });

  it('pád workeru odmítne běžící práci a frontu dojede na novém', async () => {
    // Nález nezávislého review: tahle větev byla **nedosažitelná z testů** —
    // `onerror` se v atrapě jen nastavoval na `null` a nikdo ho nezavolal.
    // Přitom dělá čtyři věci najednou a vypadnutí kterékoli z nich je tichá
    // vada: bez `pump()` každý tvar zařazený za pádem visí navždy, bez
    // `worker = null` se práce pošle mrtvému workerovi.
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const client = createMeshClient({
      createWorker: () => {
        const made = fakeWorker();
        workers.push(made);
        return made;
      },
    });

    const running = client.mesh(order);
    const queued = client.mesh({ ...order, program: { ...order.program, shapeId: 'after-crash' } });
    expect(workers).toHaveLength(1);
    expect(workers[0].queue).toHaveLength(1);

    workers[0].onerror?.(new Error('boom'));

    // 1. Běžící práce se odmítne, a to důvodem, který přišel z workeru.
    await expect(running).rejects.toThrow('boom');
    // 2. Mrtvý worker se ukončí, ať už spadl jakkoli.
    expect(workers[0].terminate).toHaveBeenCalled();
    // 3. Fronta se rozjede na **novém** workeru, ne na tom, co spadl.
    expect(workers).toHaveLength(2);
    expect(workers[1].queue).toHaveLength(1);
    expect(workers[1].queue[0].program.shapeId).toBe('after-crash');

    // 4. A dojede až do hotového meshe — pád jednoho tvaru nesmí vzít svět.
    workers[1].flush();
    const recovered = await queued;
    expect(recovered.shapeId).toBe('after-crash');
    expect(recovered.triangleCount).toBeGreaterThan(0);
  });
});

/**
 * **Přehrání archivu neuplatňuje strop času – P20 F4.**
 *
 * `maxMs` je naměřený čas stroje: týž commit dal nad týmž archivem c08
 * 380, 410 i 722 ms proti stropu 350, a tím i 21/30 v jednom běhu a 20/30
 * v dalším. `geometryAuthored` se přitom cituje jako číslo o kódu.
 *
 * Soudí se proto přes `judgeBudget`, ne přes skutečně pomalý tvar: takový test
 * by měřil stroj, na kterém běží, a červeně by svítil podle zátěže.
 */
describe('výjimka ze stropu času platí jen na čas', () => {
  const rough = MESH_DETAIL.rough;
  const overTime = { resolution: rough.resolution, triangleCount: rough.maxTriangles - 1, elapsedMs: rough.maxMs + 1 };

  it('bez výjimky přetečený čas pořád odmítá', () => {
    const verdict = judgeBudget(overTime);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') return;
    expect(verdict.error).toContain('above maxMs');
  });

  it('s výjimkou projde a přizná se k tomu', () => {
    expect(judgeBudget({ ...overTime, untimed: true }).kind).toBe('waived-time');
  });

  it('výjimka nekryje trojúhelníky, protože ty na stroji nezávisejí', () => {
    // **Tohle je celý důvod, proč `untimed` není `unbudgeted`.** Kdyby
    // přehrání pustilo i přetečené trojúhelníky, přestalo by měřit bránu,
    // která dává na každém stroji stejný verdikt.
    const verdict = judgeBudget({
      resolution: rough.resolution,
      triangleCount: rough.maxTriangles + 1,
      elapsedMs: rough.maxMs + 1,
      untimed: true,
    });
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') return;
    expect(verdict.error).toContain('above maxTriangles');
  });

  it('nesouzená práce projde pořád, a bez známky o čase', () => {
    expect(judgeBudget({ ...overTime, triangleCount: rough.maxTriangles + 1, unbudgeted: true }).kind).toBe('pass');
  });

  it('co se do rozpočtu vešlo, si známku nevyrobí ani s výjimkou', () => {
    // Bez téhle aserce by mutace „vždycky waived-time" prošla a artefakt by
    // jmenoval každý tvar světa jako zachráněný hodinami.
    const inside = { resolution: rough.resolution, triangleCount: 10, elapsedMs: rough.maxMs - 1 };
    expect(judgeBudget({ ...inside, untimed: true }).kind).toBe('pass');
    expect(judgeBudget(inside).kind).toBe('pass');
  });

  it('skutečný mesh v rozpočtu známku nenese', () => {
    const response = handleMeshJob({
      jobId: 'job-untimed-fast',
      program: programOf(SPHERE),
      sessionSeed: SEED,
      resolution: 16,
      bounds: UNIT_BOUNDS,
      untimed: true,
    }).response;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.overTime).toBeUndefined();
  });
});

describe('klient nese výjimku tam a známku zpátky', () => {
  const order = { program: { ...programOf(SPHERE), shapeId: 'hero' }, sessionSeed: SEED, resolution: 16, bounds: UNIT_BOUNDS };

  it('výchozí klient si o výjimku neříká, přehrávací ano', async () => {
    const strict = fakeWorker();
    const loose = fakeWorker();
    const a = createMeshClient({ createWorker: () => strict });
    const b = createMeshClient({ createWorker: () => loose, untimed: true });

    const first = a.mesh(order);
    const second = b.mesh(order);
    expect(strict.queue[0].untimed).toBe(false);
    expect(loose.queue[0].untimed).toBe(true);
    strict.flush();
    loose.flush();
    await Promise.all([first, second]);
  });

  it('známka z workeru dorazí až do výsledku', async () => {
    // Bez tohohle by se `overTime` ztratilo v klientovi a měřidlo by
    // vypisovalo prázdný seznam nad během, kde se o hodiny opřel každý druhý tvar.
    const worker = fakeWorker();
    const client = createMeshClient({ createWorker: () => worker, untimed: true });
    const promise = client.mesh(order);
    const request = worker.queue.shift();
    if (request === undefined) throw new Error('no queued job');
    worker.onmessage?.({
      data: {
        jobId: request.jobId, ok: true, positions: new Float32Array(9), normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]), vertexCount: 3, triangleCount: 1, bounds: UNIT_BOUNDS,
        elapsedMs: MESH_DETAIL.rough.maxMs + 60, overTime: true,
      },
    });
    expect((await promise).overTime).toBe(true);
  });
});
