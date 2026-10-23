/** Typy k `why-unseen.mjs` pro TypeScript test (konvence `evals/play/p56a/visible.d.mts`). */

export interface Box { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number; readonly behind: boolean }
export interface Role { readonly id: string; readonly kind: string; readonly label: string }
export type UnseenClass = 'no-role' | 'no-model' | 'off-screen' | 'too-small' | 'look';

export declare function carrierOf<R extends Role>(noun: string, isHero: boolean, roles: readonly R[]): R | null;
export declare function heightShare(box: Box | null | undefined): number;
export declare function onScreen(box: Box | null | undefined): boolean;
export declare function classify(input: { readonly carrier: unknown; readonly level: string | null; readonly box: Box | null; readonly threshold: number | null }): UnseenClass;
export declare function thresholdOf(points: readonly { readonly share: number; readonly visible: boolean }[]): {
  readonly threshold: number | null; readonly correct: number; readonly of: number;
  readonly seenAbove?: number; readonly above?: number; readonly seenBelow?: number; readonly below?: number;
};
export declare function rankMissing<R extends { readonly noun: string; readonly sentences: number }>(
  rows: readonly R[],
  choose: (noun: string) => { readonly level: string; readonly model: string },
): (R & { readonly level: string; readonly model: string })[];
