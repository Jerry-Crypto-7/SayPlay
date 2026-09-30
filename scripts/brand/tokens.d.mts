/** Typy k `tokens.mjs`: skript běží holým Nodem, test je TypeScript. */

export declare const SOURCE: string;
export declare const CSS_OUT: string;
export declare const TS_OUT: string;
export declare const FONT_STACK: string;
export declare const WEIGHT_MAP: { display: Record<number, number>; body: Record<number, number> };

export declare function readSource(root?: string): Record<string, unknown>;
export declare function renderCss(json: Record<string, unknown>): string;
export declare function renderTs(json: Record<string, unknown>): string;
export declare function generate(root?: string): { css: string; ts: string };
