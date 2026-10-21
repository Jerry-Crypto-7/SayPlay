/** Typy k `qa-grid.mjs` pro TypeScript testy. */

export declare function gridPlan(assets: { assetId: string }[], size: number, options?: { keepOrder?: boolean }): { sheet: string; cells: string[] }[];
export declare function cellOrigin(cell: number, size: number, cellPx: number): { x: number; y: number };
