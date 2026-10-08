/**
 * Jména, která na veřejném žebříčku nesmí stát (P44B T3a, nález revize T3-1): urážky anglicky
 * a česky a jména, která se vydávají za provozovatele. Porovnává se po normalizaci – malá písmena,
 * bez diakritiky, bez mezer a `._-` mezi písmeny („K-u-r-v-a“, „a.d.m.i.n“) – na tvaru, který už
 * prošel `readNickname`.
 */

/** Dost výrazné, aby blokovaly i uvnitř jména („BigShit“, „FuckYou“). */
const INSULTS_ANYWHERE = [
  'fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'bitch', 'retard', 'asshole', 'rapist', 'slut', 'twat', 'wank', 'penis', 'porn',
  'nazi', 'hitler',
  'kurva', 'kurvo', 'kokot', 'curak', 'zmrd', 'mrdka', 'mrdat', 'sracka', 'prdel', 'hovno', 'buzerant', 'buzna', 'kunda', 'debil',
] as const;

/** Krátké nebo běžné uvnitř nevinných slov („Grape“, „Picasso“, „Peacock“): jen jako celé slovo nebo celé jméno. */
const INSULTS_AS_WORD = ['ass', 'rape', 'dick', 'cock', 'sex', 'cum', 'fag', 'kys', 'kkk', 'heil', 'pica', 'negr', 'cikan'] as const;

/** Autorita, za kterou se nikdo nesmí vydávat – i se slovem před nebo za („Sayplay Team“, „Ada Support“). */
const RESERVED = ['admin', 'sayplay', 'moderator', 'official', 'system', 'support'] as const;

export function isBlockedName(nickname: string): boolean {
  const folded = nickname.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const words = folded.split(/[\s._-]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u);
  const joined = folded.replace(/[\s._-]+/g, '');
  const letters = joined.replace(/\p{N}+/gu, '');
  return (
    INSULTS_ANYWHERE.some((insult) => joined.includes(insult)) ||
    INSULTS_AS_WORD.some((insult) => words.includes(insult) || letters === insult) ||
    RESERVED.some((name) => letters.startsWith(name) || letters.endsWith(name))
  );
}
