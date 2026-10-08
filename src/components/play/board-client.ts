/**
 * Žebříček v prohlížeči (P44B T9). `publishDare` sem uloží, co server po přehrání běhu řekl
 * (`{ board, beat }` z `POST …/dare`), pod id výzvy – `PostRun` ho čte, až má výzvu `ready`, takže
 * výsledek patří právě tomuhle běhu, ne minulému pokusu. Řádky žebříčku čte `fetchBoard`.
 */

export interface BoardRow {
  readonly place: number;
  readonly nickname: string;
  readonly score: number;
  readonly ticks: number;
  readonly dareId: string;
  readonly you: boolean;
}

/** Ověřený výsledek běhu: `board` = místo v žebříčku (`null` = nezapsal se), `beat` = porazil výzvu (`null` = není s čím srovnat). */
export interface DareResult {
  readonly board: { readonly place: number; readonly of: number } | null;
  readonly beat: boolean | null;
}

// simplified: mapa žije po dobu stránky a neuklízí se; jeden záznam na vítězný běh je pár bajtů.
const results = new Map<string, DareResult>();

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Z odpovědi serveru jen to, čemu jde věřit; cokoli jiného je `null`. */
export function dareResultOf(body: { readonly board?: unknown; readonly beat?: unknown }): DareResult {
  const board = body.board as { place?: unknown; of?: unknown } | null | undefined;
  return {
    board: typeof board === 'object' && board !== null && count(board.place) && count(board.of) ? { place: board.place, of: board.of } : null,
    beat: typeof body.beat === 'boolean' ? body.beat : null,
  };
}

export function rememberDare(dareId: string, result: DareResult): void {
  results.set(dareId, result);
}

export function dareResult(dareId: string): DareResult | null {
  return results.get(dareId) ?? null;
}

/** Řádky `GET /api/play/games/:id/board`; `null` = čtení selhalo a žebříček se neukáže. */
export async function fetchBoard(versionId: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<BoardRow[] | null> {
  try {
    const response = await fetcher(`/api/play/games/${versionId}/board`, { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { rows?: unknown };
    return Array.isArray(body.rows) ? (body.rows as BoardRow[]) : null;
  } catch {
    return null;
  }
}
