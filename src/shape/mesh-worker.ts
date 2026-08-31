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
import { meshShapeProgram, type MeshRequest, type ShapeMesh } from './surface-nets';
import { MESH_DETAIL, type Bounds3, type ShapeProgram } from './types';

/**
 * Strop pro danou mřížku — příčka žebříku, nebo ta nejvyšší.
 *
 * Rozlišení mimo žebřík (měřicí stránka umí 64 i 96) soudí `high`. Je to
 * nejmírnější strop, jaký produkt deklaruje; mlčky propustit cokoliv jen proto,
 * že si někdo řekl o neobvyklou mřížku, by tu bránu zrušilo.
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
  readonly bounds: Bounds3;
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
    const meshRequest: MeshRequest = {
      resolution: request.resolution,
      bounds: request.bounds,
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
    const budget = budgetFor(request.resolution);
    const elapsedMs = Date.now() - startedAt;

    if (mesh.triangleCount > budget.maxTriangles) {
      return {
        response: {
          jobId: request.jobId,
          ok: false,
          error: `mesh is ${mesh.triangleCount} triangles, above maxTriangles ${budget.maxTriangles} for resolution ${request.resolution}`,
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
        },
        transfer: [],
      };
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
