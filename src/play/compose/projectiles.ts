import { nounPhrase, singular } from '../draft/lexicon';

/** Distinguish ammunition being fired from objects being fired at. */
export function namedProjectiles(sentence: string): readonly { label: string; target: string | null }[] {
  const out: { label: string; target: string | null }[] = [];
  const pattern = /\b(?:fire|fires|firing|shoot|shoots|shooting|launch|launches|launching)\s+(?:(?:a|an|the|some)\s+)?((?:(?!(?:at|into|towards?|and|or|while|then|down|over|off)\b)[a-z-]+\s+){0,2}(?:rockets?|missiles?|torped(?:o|oes)|bullets?|arrows?|lasers?|shells?|darts?|fireballs?))\b/gi;
  for (const match of sentence.matchAll(pattern)) {
    const prefix = sentence.slice(0, match.index).toLowerCase();
    if (/\b(?:not|never|without|no|don't|doesn't|mustn't)\s*$/.test(prefix)) continue;
    // A preposition before the named object makes it a target, not ammunition.
    if (/\b(?:at|into|towards?)\b/i.test(match[1]!)) continue;
    const label = singular(match[1]!.toLowerCase().replace(/torpedoes\b/g, 'torpedo'));
    const after = sentence.slice(match.index! + match[0].length);
    const targetText = /^\s+(?:at|into|towards?)\s+(.+)/i.exec(after)?.[1];
    const target = targetText === undefined ? null : nounPhrase(targetText);
    if (!out.some(item => item.label === label)) out.push({ label, target: target === null ? null : singular(target) });
  }
  return out;
}
