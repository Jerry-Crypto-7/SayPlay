/** Typy k `palette.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const toSrgb: (linear: number[]) => number[];

export declare function hueSat(rgb: number[]): any;
export declare function isPurple(srgb: number[]): boolean;
export declare function loadPalette(source?: string): any;
export declare function nearest(linear: number[], palette: any): any;
export declare function recolorDoc(doc: any, palette: any, skip?: Set<any>): any;
