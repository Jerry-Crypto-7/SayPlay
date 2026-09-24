/** Typy k `normalize.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const MAX_TRIANGLES: number;
export declare const MAX_TEXTURE: number;
export declare const quarantineDir: (assetId: string) => string;
export declare const assetIdOf: (entry: { noun: string; sense?: string }) => string;

export declare function normalizeModel(options: {
  input: string;
  assetId: string;
  label: string;
  tags: string[];
  pack: any;
  licenseFile: string;
  sourceFile: string;
  style?: boolean;
  keepTextures?: boolean;
}): Promise<any>;
export declare function purpleColours(doc: any): any[];
export declare function renderPreview(file: string): Promise<any>;
export declare function contactSheet(previews: any[]): Promise<any>;
