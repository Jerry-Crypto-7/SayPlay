import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT, KIT_BUDGETS, VIEWER_BUDGETS, buildKitScene, measureScene, trianglesOf } from '../index';

const SRC_ROOT = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('kit se vejde do rozpočtu', () => {
  it('má počet kusů mezi stropy z jednoho indexu', () => {
    expect(KIT.length).toBeGreaterThanOrEqual(KIT_BUDGETS.minPieces);
    expect(KIT.length).toBeLessThanOrEqual(KIT_BUDGETS.maxPieces);
  });

  // Strop se zvedá vědomě s každým novým kusem (P19 T6), ne do zásoby: rezerva
  // víc než dvou kusů by pustila další kus bez rozhodnutí.
  it('strop počtu kusů sedí na velikost kitu', () => {
    expect(KIT_BUDGETS.maxPieces - KIT.length).toBeLessThanOrEqual(2);
  });

  // P19 T6: kusy, podle kterých se místnost pozná (F1 §4 – frekvence × specificita).
  it.each([
    'fixture.aquarium',
    'fixture.fireplace',
    'fixture.checkout',
    'fixture.couch',
    'fixture.reception',
    'actor.seated',
    // P19 T7: venkovní vodítka pro pláž, park a balkon.
    'organic.waterline',
    'organic.path',
    'panel.railing',
    'panel.facade',
  ])('%s je v kitu', (id) => {
    expect(KIT.some((piece) => piece.id === id)).toBe(true);
  });

  it('žádné dvě id se neopakují', () => {
    const ids = KIT.map((piece) => piece.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(KIT.map((piece) => [piece.id, piece] as const))(
    '%s je pod stropem trojúhelníků na kus',
    (_id, piece) => {
      const geometry = piece.build();
      expect(trianglesOf(geometry)).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerPiece);
      geometry.dispose();
    },
  );

  it('scéna se všemi kusy najednou je pod oběma stropy', () => {
    const scene = buildKitScene();
    const measured = measureScene(scene);

    expect(measured.drawCalls).toBe(KIT.length);
    expect(measured.drawCalls).toBeLessThanOrEqual(KIT_BUDGETS.maxDrawCallsPerWorld);
    expect(measured.triangles).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
    expect(Number.isInteger(measured.triangles)).toBe(true);
  });

  it('measureScene počítá každý materiál zvlášť, ne jen meshe', () => {
    // Bez tohohle by měření mohlo být `počet meshů` a nikdo by se to nedozvěděl,
    // dokud by layout nepoužil víc materiálů na jednu geometrii.
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(1, 1, 1), [new MeshBasicMaterial(), new MeshBasicMaterial()]));

    expect(measureScene(group)).toEqual({ drawCalls: 2, triangles: 12 });
  });
});

describe('rozpočet plátna sedí s profilem', () => {
  // Profil je zdroj čísel, `VIEWER_BUDGETS` je jejich runtime kopie. Import do
  // kódu není možný (kit se staví i ve stromu fallbacku bez adresáře `data/`),
  // takže tenhle test je jediné, co drží obě kopie u sebe. Bez něj by se profil
  // dal přepsat a nikdo by se to nedozvěděl.
  const profile = JSON.parse(
    readFileSync(join(process.cwd(), 'data/profiles/web-viewer.json'), 'utf-8'),
  ) as Record<string, unknown>;

  it('každé číslo profilu má v kódu tutéž hodnotu', () => {
    expect({
      maxDrawCallsPerFrame: profile.maxDrawCallsPerFrame,
      maxTrianglesPerFrame: profile.maxTrianglesPerFrame,
      maxLights: profile.maxLights,
      shadowMapSize: profile.shadowMapSize,
    }).toEqual({
      maxDrawCallsPerFrame: VIEWER_BUDGETS.maxDrawCallsPerFrame,
      maxTrianglesPerFrame: VIEWER_BUDGETS.maxTrianglesPerFrame,
      maxLights: VIEWER_BUDGETS.maxLights,
      shadowMapSize: VIEWER_BUDGETS.shadowMapSize,
    });
  });

  it('strop snímku je nad stropem kitu, ne pod ním', () => {
    // Stínová mapa kreslí vrhající objekty podruhé, takže snímek nikdy nemůže
    // mít míň volání než scéna, ze které vznikl. Profil pod stropem kitu by byl
    // rozpočet, který nejde splnit ani prázdnou scénou.
    expect(VIEWER_BUDGETS.maxDrawCallsPerFrame).toBeGreaterThan(KIT_BUDGETS.maxDrawCallsPerWorld);
    expect(VIEWER_BUDGETS.maxTrianglesPerFrame).toBeGreaterThan(KIT_BUDGETS.maxTrianglesPerWorld);
  });

  it('rig se do stropu světel vejde přesně, ne s rezervou', () => {
    // Tři směrová a jedno polokulové. Kdyby tu byla rezerva, přestal by strop
    // hlídat rig a začal by hlídat nic.
    expect(VIEWER_BUDGETS.maxLights).toBe(4);
  });
});

describe('importní hygiena', () => {
  it('nikde v src/ není barrel import z @react-three/drei', () => {
    // Barrel táhne `@mediapipe/tasks-vision` a `hls.js` do bundlu. Povolené jsou
    // jen deep-path importy (`@react-three/drei/core/...`).
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) =>
        /(?:from|import|require\()\s*['"]@react-three\/drei['"]/.test(readFileSync(file, 'utf-8')),
      )
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });

  it('nikde v src/ není <Environment preset> z drei', () => {
    // Stahuje HDRI z raw.githack.com za běhu, čímž rozbije „žádný loading
    // screen" i service worker.
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => /<Environment[^>]*\spreset=/.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
