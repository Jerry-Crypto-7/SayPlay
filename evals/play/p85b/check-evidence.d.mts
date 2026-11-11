export const MAP_FILE: string;

export interface EvidenceReference {
  readonly path: string;
  readonly line: number | null;
  readonly from: string;
}

export function referencesOf(markdown: string, docPath?: string): EvidenceReference[];
export function rowsPerSection(markdown: string): Map<string, number>;
export function evidenceProblems(repo?: string): { problems: string[]; references: number; sections: number };
