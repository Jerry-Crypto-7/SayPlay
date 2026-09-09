/**
 * Worker, který mele tvary mimo hlavní vlákno.
 *
 * Mřížka 64³ je 274 625 vyhodnocení pole. Na hlavním vlákně by po tu dobu
 * prohlížeč nevykreslil ani jeden snímek — a „svět se staví do tří sekund"
 * znamená, že se **mezitím dívá**, ne že tři sekundy kouká na zamrzlý obraz.
 *
 * ## Proč je tady jen pět řádků obsluhy
 *
 * Všechno, co se dá otestovat, sedí v `handleMeshJob()`, což je čistá funkce.
 * Obsluha zprávy kolem ní je tenká schválně: `vitest` běží v Node bez
 * `Worker`, takže kdyby logika žila v `onmessage`, nedal by se otestovat ani
 * seznam transferovaných bufferů — a právě ten je v zadání úlohy.
 *
 * ## Transferable buffery
 *
 * Mesh se **předává**, nekopíruje. `postMessage` bez seznamu přenosů udělá
 * strukturovanou kopii, tedy u 30 000 trojúhelníků zhruba megabajt navíc a
 * pauzu na obou vláknech. Se seznamem se přenese vlastnictví paměti a kopie
 * nevznikne. Cena je, že buffery jsou po odeslání ve workeru **odpojené** —
 * proto se v `handleMeshJob()` po sestavení odpovědi už nesmějí číst.
 *
 * ## Worker svému vstupu nevěří
 *
 * Brána `validateShapeProgram()` je **první řádek** práce, a to i když program
 * dnes píše ruční galerie, která jí prokazatelně projde. Naměřeno 29. 8. 2026
 * mutací: program s odkazem na uzel mimo tabulku se do té doby nezastavil
 * nikde, propadl až do `field.ts` a vrátil se jako
 * `TypeError: Cannot read properties of undefined (reading 'kind')`.
 *
 * **Ta hláška je ta vada, ne ten pád.** Od vlny 2 píše `ShapeProgram` model a
 * důvod odmítnutí je vstup sebeopravy — z „nemůžu přečíst vlastnost undefined"
 * se opravit nedá, z „node 3 references node 7 outside the table of 4" ano.
 * Proto se sem posílá **celý** program, ne jen `nodes` a `root`: brána soudí
 * i obálku (`targetBounds`, `anchors`, rozpočty) a je to **táž jediná brána**,
 * jakou používá emisní cesta. Druhý, zjednodušený validátor uvnitř workeru by
 * se s ní dřív nebo později rozešel.
 */

import { validateShapeProgram } from './schema';
import { meshShapeProgram, paddedBounds, type MeshRequest, type ShapeMesh } from './surface-nets';
import { MESH_DETAIL, type Bounds3, type ShapeProgram } from './types';

/**
 * Strop pro danou mřížku — příčka žebříku, nebo ta nejvyšší.
 *
 * Rozlišení mimo žebřík soudí `high`. Je to nejmírnější strop, jaký produkt
 * deklaruje; mlčky propustit cokoliv jen proto, že si někdo řekl o neobvyklou
 * mřížku, by tu bránu zrušilo.
 *
 * **Měření tudy nechodí, a to celé.** `unbudgeted` je volba klienta, ne jedné
 * objednávky, takže měřicí stránka obchází rozpočet u **všech čtyř** mřížek,
 * i u obou příček žebříku — ne jen u 64³ a 96³, které report vede bez rozsudku.
 * Rozsudek nad příčkami se tím neztratil, jen se přesunul za pořízení čísel do
 * `e2e/mesh-budget.spec.ts`. Pozor, že ten spec je značkou `@measure` mimo
 * `npm run test:e2e`: příčky se tedy soudí jen při ručním měření. Viz
 * `MeshJobRequest.unbudgeted`.
 */
function budgetFor(resolution: number): (typeof MESH_DETAIL)[keyof typeof MESH_DETAIL] {
  return resolution <= MESH_DETAIL.rough.resolution ? MESH_DETAIL.rough : MESH_DETAIL.high;
}

/** Zadání jedné práce. Program se posílá jako data, ne jako funkce. */
export interface MeshJobRequest {
  readonly jobId: string;
  readonly program: ShapeProgram;
  readonly sessionSeed: number;
  readonly resolution: number;
  /**
   * Kvádr zadání **syrový, bez rezervy**.
   *
   * Rezervu jedné buňky přidává `handleMeshJob()` sám (viz `paddedBounds`),
   * takže volající, který si ji přidá taky, nafoukne kvádr dvakrát a měří
   * mřížku, kterou produkt nikdy nemele. Naměřeno nezávislou revizí
   * 2. 9. 2026: sedm fixtur v `__tests__/mesh.test.ts` to dělalo — brána
   * rozpočtu se pinovala na 193 702 trojúhelnících proti produkčním 190 486.
   */
  readonly bounds: Bounds3;
  /**
   * Změřit, ale nesoudit. **Jediné dveře ven z rozpočtu, a jsou pojmenované.**
   *
   * Měřicí stránka `/dev/mesh-budget` si říká o mřížky **mimo žebřík** (64³
   * a 96³), které report vede schválně bez rozsudku — nemá je tedy co soudit
   * příčka, do které nepatří. Naměřeno 31. 8. 2026: `budgetFor(64)` vrátí
   * `high`, tedy strop 48³, a worker vlastní měření odmítl s
   * `mesh is 47680 triangles, above maxTriangles 32000`. Report tím šlo od
   * 29. 8. jen číst, ne přeměřit — vynucování rozpočtů přišlo až po jeho
   * posledním běhu a značka `@measure` drží ten spec mimo `npm run test:e2e`,
   * takže šest dní nebylo co by se ozvalo.
   *
   * **Výchozí hodnota je ta přísná**, takže se sem nedá dostat zapomenutím —
   * jen tím, že si o to někdo řekne, stejně jako o `allowMainThread`. Produkt
   * si o to říct nemůže: `MeshOrder` tohle pole nemá, nese ho až
   * `createMeshClient({ unbudgeted: true })`, tedy celý klient měřicí stránky.
   *
   * **Platí to pro celého klienta, ne pro jednu mřížku.** Měřicí stránka tedy
   * obejde rozpočet i u 32³ a 48³, tedy u obou příček, které `MESH_DETAIL`
   * doopravdy definuje. Je to schválně — měřidlo, které smí odmítnout vlastní
   * vzorek, měří jen ty vzorky, co se povedly. Rozsudek nad příčkami dělá
   * `e2e/mesh-budget.spec.ts` nad hotovým reportem, a **je to jediné místo,
   * kde se dnes soudí**; `npm run test:e2e` ho značkou `@measure` vynechává.
   *
   * **Co to nevypíná:** bránu programu, kontrolu zadání ani prázdný mesh.
   * Vypnout jde jen rozpočet, protože jen rozpočet je vlastnost příčky.
   * A hlavně to **nemění, kde se měří** — práce dál běží ve workeru a
   * `elapsedMs` dál znamená totéž co u souzených řádků. Kdyby se měřilo mimo
   * worker, dvě čísla v jednom sloupci reportu by se přestala dát srovnat.
   */
  readonly unbudgeted?: boolean;
}

export interface MeshJobSuccess {
  readonly jobId: string;
  readonly ok: true;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly bounds: Bounds3;
  /** Kolik to trvalo ve workeru. Rozpočty vlny 1 T5 se pinují na tohle číslo. */
  readonly elapsedMs: number;
}

export interface MeshJobFailure {
  readonly jobId: string;
  readonly ok: false;
  readonly error: string;
  /**
   * Odmítnutí padlo na **rozpočtu příčky** — trojúhelníky nebo čas — a na
   * ničem jiném. Prázdný mesh, vadné zadání ani brána programu tenhle příznak
   * nenesou.
   *
   * Je to příznak, ne věta, schválně. Volající, který na přetečený rozpočet
   * odpovídá hrubší mřížkou (`src/worldstream/proxy.ts`), by jinak musel číst
   * prózu psanou pro porotce — a ta se smí kdykoli přepsat. `T14r-meshbudget`
   * je přesně ta třída vady, kdy se osm světů tiše vrátí na krabici, protože
   * se pohnulo slovo v hlášce.
   */
  readonly overBudget?: true;
  /**
   * Odmítnutí padlo na **prázdném meshi**, tedy na tom, že v objednaném kvádru
   * i s rezervou workeru žádný povrch není.
   *
   * Je to vlastní příznak ze stejného důvodu jako `overBudget`: proxy na něj
   * reaguje sestupem o příčku níž. Vypadá to jako opakování téhož výpočtu, ale
   * není — rezerva je **jedna buňka**, tedy `1/resolution` kvádru, takže 24³
   * rezervuje 4,17 % tam, kde 32³ rezervovalo 3,13 %. Tvar, který svou krabici
   * přeteče o kousek víc než jednu buňku, je na hrubší příčce **uvnitř**.
   *
   * Naměřeno 9. 9. 2026 nad archivem `create-raw.json`: ze 41 tvarů, které
   * projdou bránou, je `chessBoardShape` (c26) jediný, který na první příčce
   * vrátí prázdno — a na 24³ z něj vyleze 4 232 trojúhelníků. Bez sestupu byl
   * jediným hrdinou celého archivu, který spadl na hlínu.
   */
  readonly emptyMesh?: true;
}

export type MeshJobResponse = MeshJobSuccess | MeshJobFailure;

/** Odpověď plus paměť, jejíž vlastnictví se má předat. */
export interface MeshJobOutcome {
  readonly response: MeshJobResponse;
  readonly transfer: ArrayBuffer[];
}

/**
 * Vady **zadání práce**, na které brána programu nedosáhne.
 *
 * `bounds` a `resolution` nejsou pole `ShapeProgram` — skládá je volající,
 * takže `validateShapeProgram` o nich neví a vědět nemá. Bez téhle kontroly je
 * degenerovaná mřížka **tichý úspěch**: naměřeno 30. 8. 2026, plochý kvádr
 * i `resolution: 0` vrátí `ok: true` a nula trojúhelníků. Klient slib splní,
 * stránka si napočítá hotový tvar a na plátně není nic.
 *
 * Strop mřížky tu schválně **není**. Nesmyslně velká mřížka spadne na alokaci
 * a vrátí se jako pojmenované selhání už dnes; zakázat ji tady by jen zakrylo
 * jedinou cestu k `catch` níž, kterou má tenhle soubor otestovanou.
 */
function meshRequestIssues(request: MeshJobRequest): string[] {
  const issues: string[] = [];

  if (!Number.isInteger(request.resolution) || request.resolution < 1) {
    issues.push(`resolution ${request.resolution} is not a whole number of at least 1`);
  }

  (['x', 'y', 'z'] as const).forEach((axis, index) => {
    const min = request.bounds.min[index];
    const max = request.bounds.max[index];
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      issues.push(`bounds on ${axis} are not finite numbers`);
    } else if (min >= max) {
      issues.push(`bounds on ${axis} are flat or inverted: ${min} to ${max}`);
    }
  });

  return issues;
}

/**
 * Celá práce workeru jako čistá funkce.
 *
 * Výjimku nepropouští ven: pád jednoho tvaru nesmí shodit worker, protože pak
 * by s ním padly i všechny tvary ve frontě za ním. Chyba se vrací jako
 * odpověď, kterou klient přeloží na odmítnutý slib.
 *
 * Brána běží **před** `try`, ne uvnitř. Vypadá to jako detail, ale je to celý
 * rozdíl mezi odmítnutím a pádem: `catch` umí jen zopakovat, co řekla výjimka,
 * kdežto brána vadu pojmenuje a řekne, na kterém řádku tabulky je.
 *
 * **Jedno kolo ale nemusí stačit, a je to naměřené.** `validateShapeProgram`
 * se při vadě schématu ke strukturální kontrole vůbec nedostane a strukturální
 * kontrola se po indexových vadách utne před rozpočty. Program s velkým
 * poloměrem, kořenem mimo tabulku a plochým `targetBounds` naráz vrátí
 * 30. 8. 2026 **jediný** důvod: `schema:/nodes/0/radius: Too big`. Sebeoprava
 * proto může potřebovat několik kol — brána zaručuje pojmenovaný důvod, ne
 * úplný seznam.
 */
export function handleMeshJob(request: MeshJobRequest): MeshJobOutcome {
  const startedAt = Date.now();

  const validation = validateShapeProgram(request.program);
  if (!validation.ok) {
    return {
      response: {
        jobId: request.jobId,
        ok: false,
        error: `invalid shape program: ${validation.issues.join('; ')}`,
      },
      transfer: [],
    };
  }

  const requestIssues = meshRequestIssues(request);
  if (requestIssues.length > 0) {
    return {
      response: {
        jobId: request.jobId,
        ok: false,
        error: `invalid mesh request: ${requestIssues.join('; ')}`,
      },
      transfer: [],
    };
  }

  try {
    // **Rezerva jedné buňky bydlí tady, ne u volajícího** — rozhodnuto
    // 2. 9. 2026 v `T13-meshpadding`.
    //
    // `paddedBounds()` existovala od 29. 8. i s naměřenou tabulkou v hlavičce,
    // a **nevolal ji ani jeden produkční volající**: `proxy.ts`, `/gallery`
    // i `/dev/mesh-budget` posílaly `program.targetBounds` syrově.
    //
    // **Zavírá se tím vlásečnicový přesah, ne přesný sed** — naměřeno při psaní
    // testu 2. 9. 2026, protože zadání úlohy tvrdilo obojí. Vzorek na hranici
    // má vzdálenost přesně 0 a znaménko se soudí `value < 0`, takže nula je
    // „venku" a přesně sedící kvádr `2³` se vymeshuje i bez rezervy (6 348
    // trojúhelníků v mřížce 24 tak jako tak). Zmizí až tvar, který svůj kvádr
    // přeteče o 1e-6: pak je i krajní vzorek uvnitř, žádná buňka nemění
    // znaménko a meshovač poctivě vrátí prázdno. Neprojeví se to jako pád —
    // objekt spadne na hlínu s hláškou `empty mesh`, tedy jako by ho napsal
    // špatně model.
    //
    // Ve workeru to platí pro každého volajícího naráz a hlavně **měřidla
    // měří tu cestu, kterou produkt doopravdy jde**. Kdyby rezerva byla
    // v objednávce, `/dev/mesh-budget` by kalibroval rozpočty na kódu, kterým
    // nikdo neprochází.
    //
    // **Cena, naměřená nad dvanácti tvary galerie 2. 9. 2026:** 164 668 →
    // 150 468 trojúhelníků, tedy **−8,6 %** celkem, po tvarech od −19,6 %
    // (`net`) po **+8,1 % (`column`)** — rezerva mřížku posune, nezmenší ji
    // monotónně, takže „ubere zhruba 12 %" je nepravda a nepiš ji. Nejbližší
    // dvojice galerie se vzdálila (`cloud`/`fruit` 0,1663 → 0,1707, práh
    // 0,15), takže brána K1 zůstala zelená.
    const meshRequest: MeshRequest = {
      resolution: request.resolution,
      bounds: paddedBounds(request.bounds, request.resolution),
    };
    const mesh: ShapeMesh = meshShapeProgram(request.program, request.sessionSeed, meshRequest);

    // **Práce, ze které nevyleze ani jeden trojúhelník, je selhání, ne úspěch.**
    // Pro `meshShapeProgram()` je prázdno správná odpověď a má na to vlastní
    // testy — povrch v tom výřezu prostě není. Pro objednávku tvaru je ale
    // prázdno „zmizelý hrdina": volající slib splní, započítá si hotový objekt
    // a nevykreslí nic.
    //
    // Kontrola je tady schválně **na výsledku, ne na vstupu**. Cest, jak
    // vyrobit prázdno, je víc, než jde vyjmenovat: kvádr mimo tvar, kvádr celý
    // uvnitř tvaru (viz `paddedBounds`), tvar odsunutý deformací. Vyjmenovaný
    // seznam by jednu z nich vždycky minul.
    if (mesh.triangleCount === 0) {
      return {
        response: {
          jobId: request.jobId,
          ok: false,
          error:
            'empty mesh: no surface inside the requested box (the shape sits outside it, or the box lies entirely inside the shape)',
          emptyMesh: true,
        },
        transfer: [],
      };
    }

    // **Rozpočty se soudí na výsledku, ze stejného důvodu jako prázdno o kus
    // výš.** Vstupní brána váží řádky, kopie a vyhodnocení na buňku — ale ani
    // jedno z nich neváže povrch, který vyleze. Tři legální uzly (koule plus
    // dvě `displace`) daly 29. 8. 2026 v mřížce 48 **190 442 trojúhelníků**,
    // šestinásobek stropu tvaru a 1,6násobek rozpočtu celého světa; do vlny 3
    // to `MESH_DETAIL` deklaroval a nikdo to nečetl.
    //
    // Čas se soudí **až po doběhnutí**: práci to nepřeruší, takže jednu pomalou
    // objednávku fronta pořád odstojí. Ubrání to opakování a hlavně to dá
    // modelu pojmenovaný důvod k sebeopravě. Přerušení uprostřed by znamenalo
    // hodiny ve vzorkovací smyčce, což je změna ceny meshování — vlastní úloha,
    // ne oprava u review.
    const elapsedMs = Date.now() - startedAt;

    if (request.unbudgeted !== true) {
      const budget = budgetFor(request.resolution);

      if (mesh.triangleCount > budget.maxTriangles) {
        return {
          response: {
            jobId: request.jobId,
            ok: false,
            error: `mesh is ${mesh.triangleCount} triangles, above maxTriangles ${budget.maxTriangles} for resolution ${request.resolution}`,
            overBudget: true,
          },
          transfer: [],
        };
      }

      if (elapsedMs > budget.maxMs) {
        return {
          response: {
            jobId: request.jobId,
            ok: false,
            error: `mesh took ${elapsedMs} ms, above maxMs ${budget.maxMs} for resolution ${request.resolution}`,
            overBudget: true,
          },
          transfer: [],
        };
      }
    }

    return {
      response: {
        jobId: request.jobId,
        ok: true,
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        vertexCount: mesh.vertexCount,
        triangleCount: mesh.triangleCount,
        bounds: mesh.bounds,
        elapsedMs,
      },
      transfer: [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer] as ArrayBuffer[],
    };
  } catch (error) {
    return {
      response: {
        jobId: request.jobId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      transfer: [],
    };
  }
}

/**
 * Jen ta část `self`, kterou worker doopravdy používá.
 *
 * Knihovna `webworker` se do `tsconfig.json` přidat nedá — `lib` už obsahuje
 * `dom` a ty dvě deklarují tytéž názvy dvakrát. Vlastní minimální rozhraní je
 * levnější než druhý `tsconfig` pro jeden soubor.
 */
interface MeshWorkerScope {
  postMessage(message: MeshJobResponse, transfer: ArrayBuffer[]): void;
  onmessage: ((event: { data: MeshJobRequest }) => void) | null;
}

// Obsluha se registruje jen tam, kde `self` doopravdy je worker. V Node ani
// v SSR se nic nestane a modul se dá normálně importovat kvůli typům a testu.
// Podmínka `!('document' in scope)` odděluje worker od okna: v okně je `self`
// taky, a bez ní by si stránka přepsala vlastní `onmessage`.
const workerScope: MeshWorkerScope | undefined =
  typeof self !== 'undefined' && typeof self.postMessage === 'function' && !('document' in self)
    ? (self as unknown as MeshWorkerScope)
    : undefined;

if (workerScope !== undefined) {
  workerScope.onmessage = (event) => {
    const { response, transfer } = handleMeshJob(event.data);
    workerScope.postMessage(response, transfer);
  };
}
