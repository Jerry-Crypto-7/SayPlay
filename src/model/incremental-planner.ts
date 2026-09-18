/**
 * **Přírůstkový plánovač (P21 T9): věta → pořadí kusů, jeden kus = jedna věc.**
 *
 * Stavba rozhovorem (A10) stojí na tom, že jedna odeslaná věta přidá do světa
 * **jeden** kus — jeden objekt, nebo jedno pravidlo, nebo jednu změnu něčeho,
 * co už stojí. Model to sám od sebe nedrží: na „add a lantern and a bell"
 * vrátí buď oba (a kontrakt přidání čte jen jeden objekt), nebo si jeden
 * vybere a druhý tiše zahodí. Obojí vypadá jako úspěch. Tenhle soubor proto
 * větu **rozřeže dřív, než ji kdo pošle**, a poví, kolik kusů v ní je a
 * v jakém pořadí; volající pošle první a zbytek vrátí porotci jako frontu.
 *
 * ## Co se řeže a co ne — naměřeno nad zaznamenanými větami
 *
 * Řeže se jen tam, kde další klauzule **začíná novou věc**: na tečce,
 * středníku, „then", a na „and" následovaném slovesem přidání nebo novým
 * podmětem (`add`, `put`, `place`, `there is`, `a new`, `another`, `when`, `if`). Spojka
 * „and" uprostřed jedné změny („make it wider and give it fewer teeth",
 * „bigger and let them sway") se **nedělí** — dvacet zaznamenaných vět druhé
 * věty (`evals/worldstream/refine.jsonl`) je jedna změna smíšeného rozsahu
 * a router je tak soudí; rozdělit je by A4 rozbilo. Test to připíchne.
 *
 * ## Tři druhy kusu
 *
 * - `object` — zakládá věc, která ve světě není (`add`, `put`, `place`,
 *   `there is`, věta začínající neurčitým členem). Jde na kontrakt přidání.
 * - `rule` — zakládá zákon („when … , … opens"; „every time"; „should").
 * - `change` — mění, co už stojí („make the well deeper"). Jde na grounding
 *   a refine, jako dosud.
 *
 * Druh rozhoduje **první** shoda v tomhle pořadí, protože „add a gate that
 * closes at night" je objekt s chováním, ne pravidlo. Rozřazení je nápověda
 * pro frontu a pro měření (T11), ne brána: co se doopravdy stane, rozhodne
 * grounding a čtení odpovědi modelu, jako dosud.
 *
 * ## Věta bez obsahu
 *
 * „ok", „hmm", „something nice" projdou moderací (nejsou prázdné ani
 * zakázané) a model by na ně vymyslel objekt. Kus, který nenese jediné slovo
 * mimo zdvořilostní a zájmenný seznam, se zahodí; věta, ze které nezbude kus,
 * je `NO_CONTENT` — pojmenované odmítnutí, ne placené volání.
 */

export type PieceKind = 'object' | 'rule' | 'change';

export interface Piece {
  readonly kind: PieceKind;
  /** Text kusu tak, jak půjde modelu — bez spojky, kterou se odřízl. */
  readonly text: string;
}

export type IncrementResult =
  | { readonly ok: true; readonly pieces: readonly Piece[] }
  | { readonly ok: false; readonly reason: 'NO_CONTENT'; readonly detail: string };

/** Hranice, za kterou začíná nová věc. Pořadí alternativ nerozhoduje, řeže se na všech. */
const BOUNDARY =
  /\s*(?:[.;!?]+\s+|,?\s+(?:and\s+)?then\s+|,?\s+after\s+that,?\s+|,?\s+(?:and\s+)?also\s+|,?\s+and\s+(?=(?:add|put|place|there\s+(?:is|are)|a\s+new|another|when(?:ever)?|if|every\s+time|each\s+time)\b))/i;

const OBJECT_CUE = /^(?:(?:please\s+)?(?:add|put|place|drop|build|create|spawn|include)\b|there\s+(?:is|are|should\s+be)\b|(?:a|an|another|one|two|three|some)\s+\w)/i;
const RULE_CUE = /\b(?:when(?:ever)?|if|unless|until|after|once|every\s+time|each\s+time|should|so\s+that|as\s+soon\s+as)\b/i;

/** Slova, která samy o sobě nic nepojmenovávají. Kus složený jen z nich je prázdný. */
const HOLLOW = new Set([
  'ok', 'okay', 'hmm', 'hm', 'yes', 'yeah', 'no', 'nope', 'please', 'thanks', 'thank', 'you', 'nice', 'good',
  'cool', 'great', 'fine', 'something', 'anything', 'nothing', 'everything', 'more', 'stuff', 'things', 'thing',
  'it', 'that', 'this', 'these', 'those', 'do', 'does', 'did', 'go', 'add', 'make', 'put', 'place', 'give', 'the',
  'a', 'an', 'and', 'or', 'then', 'also', 'now', 'here', 'there', 'just', 'very', 'really', 'some', 'any',
  'let', 'lets', 'us', 'me', 'my', 'we', 'i', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'be',
  'again', 'else', 'new', 'one', 'another', 'other', 'same', 'like', 'want', 'would', 'could', 'can', 'maybe',
  'perhaps', 'sure', 'well', 'so', 'um', 'uh', 'huh', 'hello', 'hi', 'hey', 'idk', 'whatever', 'random',
]);

function hasContent(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((word) => word.length >= 3 && !HOLLOW.has(word));
}

function kindOf(text: string): PieceKind {
  if (OBJECT_CUE.test(text)) return 'object';
  if (RULE_CUE.test(text)) return 'rule';
  return 'change';
}

export function planIncrement(sentence: string): IncrementResult {
  const pieces = sentence
    .replace(/\s+/g, ' ')
    .trim()
    .split(BOUNDARY)
    .map((clause) => clause.trim().replace(/^(?:and|then|also|please)\s+/i, '').replace(/[.;!?,]+$/, '').trim())
    .filter((clause) => clause.length > 0 && hasContent(clause))
    .map((text): Piece => ({ kind: kindOf(text), text }));

  if (pieces.length === 0)
    return {
      ok: false,
      reason: 'NO_CONTENT',
      detail: 'the sentence names nothing to add or change; say what should appear, or what should happen',
    };

  return { ok: true, pieces };
}
