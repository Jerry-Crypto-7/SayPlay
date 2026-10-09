/** Typy k `motion-class.mjs` pro TypeScript testy (konvence `scripts/p37d/missing-nouns.d.mts`). */

export type BodyClass = 'biped' | 'quadruped' | 'flyer' | 'swimmer' | 'vehicle' | 'prop';
export type MotionPart = { id: string; node: string; role: string; pivot: number[] };
export type MotionEntry = { class: BodyClass; parts?: MotionPart[]; regions?: { midX?: number; wingX?: number; tailZ?: number; legY?: number } };
export type MotionCatalog = { version: number; catalogHash: string; models: Record<string, MotionEntry> };

export declare const OUT: string;
export declare const SWIMMERS: Set<string>;
export declare const FLYERS: Set<string>;
export declare function catalogHash(catalog: { assets: readonly { assetId: string; hash: string }[] }): string;
export declare function roleOf(name: string, catalog?: boolean): string | null;
export declare function motionCatalog(inputs: { catalog: unknown; manifest: unknown; nodesOf: (asset: unknown) => Promise<{ name: string; pivot: number[] }[]> }): Promise<MotionCatalog>;
export declare function render(result: MotionCatalog): string;
