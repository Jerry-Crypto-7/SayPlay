/** Typy k `import-cc0.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

import type { Document } from '@gltf-transform/core';

export declare const CACHE_DIR: string;
export declare const MAX_TRIANGLES: number;
export declare const MAX_BYTES: number;
export declare const MAX_TEXTURE: number;
export declare const HEIGHT_M: number;
export declare const STATE_CLIPS: Readonly<Record<string, readonly string[]>>;
export declare const STATES: readonly string[];
export declare const PACK_NAMES: Readonly<Record<string, string>>;
export declare const SKIN_TONES: readonly string[];
export declare function skinToneOf(id: string): string;

export declare interface Character {
  readonly source?: string;
  readonly file?: string;
  readonly id: string;
  readonly name: string;
  readonly class: string;
  readonly tags: readonly string[];
}

export declare const CHARACTERS: readonly Required<Character>[];

export type Built =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly clips: Partial<Record<string, string>>;
      readonly triangles: number;
      readonly simplifiedFrom: number | null;
      readonly textures: number;
      readonly dims: [number, number, number];
      readonly fallback: string;
      readonly skinTone: string | null;
      readonly purpleShare: number;
    }
  | { readonly ok: false; readonly reason: string };

export declare function clipMap(names: readonly string[]): Partial<Record<string, string>>;
export declare function missingClips(clips: Partial<Record<string, string>>): string | null;
export declare function processDocument(doc: Document, character: Character): Promise<Built>;
export declare function importCharacter(character: Required<Character>, cacheDir?: string): Promise<Built & { readonly sourceSha256: string }>;
