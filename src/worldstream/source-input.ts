/** A supplement is separate user-authored data, never a rewrite of the source. */
import { createSourceSnapshot, EVIDENCE_LIMITS, type EvidenceResult, type SourceSnapshot } from './evidence';

export function supplementInput(text: string) {
  return { sourceId: 'user_supplement', title: 'User supplement', text,
    mediaType: 'text/plain', origin: 'user-supplement', rights: 'owned' } as const;
}

export async function sourceInputs(source: unknown, supplement?: string): Promise<EvidenceResult<readonly SourceSnapshot[]>> {
  const original = await createSourceSnapshot(source);
  if (!original.ok || original.value.origin === 'user-supplement') return { ok: false, issues: ['SOURCE_INVALID'] };
  if (supplement === undefined) return { ok: true, value: [original.value] };
  const added = await createSourceSnapshot(supplementInput(supplement));
  if (!added.ok || added.value.sourceId === original.value.sourceId) return { ok: false, issues: ['SUPPLEMENT_INVALID'] };
  if (new TextEncoder().encode(original.value.text + added.value.text).byteLength > EVIDENCE_LIMITS.sourceBytes)
    return { ok: false, issues: ['SOURCE_TOTAL_TOO_LARGE'] };
  return { ok: true, value: [original.value, added.value] };
}
