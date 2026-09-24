/**
 * Věta pro model o odmítnutém blueprintu – vyčleněná z `worldstream-repair.ts`,
 * aby ji stavba scény (`worldstream/proxy.ts`) mohla volat bez celé opravné smyčky,
 * která s sebou táhne plný katalog assetů do stránky hry.
 */

import { rejectionSentence } from './local/rejection-prompt';
import type { CompilerRejection, WorldRejection } from './worldstream-compiler';

/** Odmítnutí compileru bez obálky výsledku. Tolik, kolik potřebuje věta. */
export interface BlueprintFault {
  readonly reason: CompilerRejection;
  readonly detail: string;
  readonly issues: readonly string[];
  /** Jen u `WORLD_REJECTED`: odmítnutí certifikace celé, i s fází a svědkem. */
  readonly world?: WorldRejection;
}

/**
 * Kolik nálezů se vejde do věty.
 *
 * Ne jeden (smyčka by se protočila nad týmž blueprintem, viz hlavička) a ne
 * všechny (jeden vadný program umí vyrobit desítky hlášek a ty by z okna
 * vytlačily samotnou odpověď). Zbytek se **spočítá**, aby model věděl, že
 * seznam pokračuje.
 */
const MAX_ISSUES_IN_SENTENCE = 6;

/**
 * Co s tím má model udělat, pro každý důvod zvlášť.
 *
 * Uzavřený záznam, ne `switch` s `default`: nový důvod v `CompilerRejection`
 * neprojde přes `tsc`, dokud mu někdo nenapíše instrukci. Bez toho by se nová
 * vada tiše přeložila na obecnou větu, což je přesně ten `invalid shape`,
 * kterému se celý modul vyhýbá.
 */
const WHAT_TO_DO: Readonly<Record<CompilerRejection, string>> = {
  LAYOUT_INVALID:
    'Fix the named spatial relation or blocked opening using actual object bounds. Preserve identities, bindings and required counts; do not hide the relation or remove the requested object.',
  NOT_AN_OBJECT:
    'Answer with one JSON object whose fields are exactly geometry, shapes, placements and world.',
  WRONG_SHAPE:
    'Fix exactly that field and send the whole answer back, keeping every part that was already right.',
  EXAMPLE_COPIED:
    'Write your own node table for this brief. The example shows the shape of an answer, never its content, and renaming what sits around a copied table does not make it yours.',
  GEOMETRY_NOT_AUTHORED:
    'Write the composition out as a node table. There is no library of finished places, so a name is never an answer.',
  GEOM_INVALID:
    'Fix that node and send the whole answer back. Every child index is lower than the row that names it, and every argument stays inside the range the capability manifest gives.',
  /**
   * ⚠ **„that one shape … leave the other shapes as they are" tu stálo do
   * 9. 9. 2026 a rušilo to opravu o patro výš** (nález nezávislé revize).
   * `T14r-shapefirstfault` nechal compiler odmítnout až za všemi vadnými tvary,
   * takže věta jich dnes jmenuje víc — a hned za tím stál příkaz ostatní tvary
   * nechat být. Model tedy opravil jeden na kolo dál, tedy přesně ta cena,
   * kvůli které se sběr stavěl. Věta říká, co se jmenuje, ne kolik toho je.
   */
  SHAPE_INVALID:
    'Rewrite every shape named here inside the budget the capability manifest names, and leave the shapes that were not named as they are.',
  PLACEMENT_MISMATCH:
    'Place every object you were given exactly once, and place no id the brief did not name.',
  REFERENCE_BROKEN:
    'Make the link run both ways: a shape names its object in stableId, and that object sources from that shape.',
  BLUEPRINT_INVALID:
    'Fix that field and send the whole answer back, keeping every part that was already right.',
  /**
   * ⚠ **Záloha, ne hlavní cesta.** Když odmítnutí nese `world`, radu píše
   * `rejectionSentence()` a je jiná pro každou ze sedmi fází certifikace. Tahle
   * věta zbývá pro jediný případ, kdy certifikace skončí neúspěchem bez
   * `Rejection` — a i tam má být použitelná.
   */
  WORLD_REJECTED:
    'Repair the world field only. Declare every name you reference, use only the listed events, conditions and actions, and keep the geometry you already wrote.',
};

/**
 * Text bez interpunkce a mezer. Slouží jen k porovnání, nikdy k zobrazení.
 *
 * ⚠ **Bez tohohle srovnání se první nález opisuje dvakrát** a podruhé s
 * návěštím „a každý zvlášť". Compiler totiž `detail` z `issues[0]` skládá
 * **přeformátovaně**: `shapes/0: program expands to…` se ve větě objeví jako
 * `shapes[0]: program expands to…`, u referencí se dvojtečka mění na mezeru.
 * Doslovné `includes` proto nikdy nesedne. Naměřeno 31. 8. 2026 nezávislou
 * revizí nad tvarem, který se rozbalí na 4 096 kopií.
 */
function squash(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '');
}

/** Nálezy, které ve `detail` ještě nezazněly — ten je u části důvodů `issues[0]`. */
function extraIssues(fault: BlueprintFault): readonly string[] {
  const detail = squash(fault.detail);
  return fault.issues.filter((issue) => !detail.includes(squash(issue)));
}

/**
 * Adresa, ke které ten nález patří — `shapes/1`, `geometry/nodes/3`.
 *
 * Nálezy vznikají jako `<adresa>: <co je špatně>`. Nerozpoznaný tvar dostane
 * vlastní přihrádku pod sebou samým, takže se nikdy neslije s cizí.
 */
function issueAddress(issue: string): string {
  return issue.split(':')[0]?.trim() ?? issue;
}

/**
 * Vybrat nálezy tak, aby **každá vadná adresa dostala hlas**.
 *
 * ⚠ **Nález nezávislé revize 9. 9. 2026, naměřený.** Do té chvíle se bralo
 * prvních šest nálezů v pořadí, v jakém přišly, a ty jsou řazené po tvarech.
 * Jeden špatně tvarovaný tvar přitom vyrobí **sedm** hlášek ze schématu, takže
 * vyplnil celý rozpočet věty sám a druhý vadný tvar se do ní nedostal ani
 * jménem — přesně to, co `T14r-shapefirstfault` zavíralo o patro výš, když
 * compiler přestal odmítat na prvním vadném tvaru. Sběr všech nálezů je
 * k ničemu, když je věta pro model zase neunese.
 *
 * Bere se proto **kolo po kole přes adresy**: první nález každé adresy, pak
 * druhý každé adresy, dokud se rozpočet nevyčerpá. Pořadí uvnitř adresy
 * i pořadí adres zůstává, jak přišlo.
 */
function fairShare(issues: readonly string[], budget: number): readonly string[] {
  const byAddress = new Map<string, string[]>();
  for (const issue of issues) {
    const address = issueAddress(issue);
    const bucket = byAddress.get(address);
    if (bucket === undefined) byAddress.set(address, [issue]);
    else bucket.push(issue);
  }

  const picked: string[] = [];
  for (let round = 0; picked.length < budget; round += 1) {
    const before = picked.length;
    for (const bucket of byAddress.values()) {
      if (picked.length >= budget) break;
      const issue = bucket[round];
      if (issue !== undefined) picked.push(issue);
    }
    // Žádná adresa už na tomhle kole nic nemá, takže další kolo taky nic nedá.
    if (picked.length === before) break;
  }
  return picked;
}

/**
 * Věta pro model. Vždycky neprázdná a vždycky s kódem na začátku.
 *
 * Kód je tam pro **člověka i pro model**: porotce ho vidí v Inspect zásuvce
 * (design book §16) a model podle něj pozná, že jde o tutéž vadu jako minule.
 *
 * ## Svět má vlastní slovník a ten se sem neopisuje
 *
 * Certifikace odmítá v **sedmi fázích** a `local/rejection-prompt.ts` má radu
 * pro každou zvlášť — u `NO_FIT` dokonce spočítá, který tier by se hodil.
 * Kdyby se nad ni pověsila jedna obecná věta z `WHAT_TO_DO`, dostal by svět,
 * jehož cesta nevyhrává, radu „deklaruj jména a používej jen povolené akce" —
 * tedy odpověď na úplně jinou vadu. Fáze proto sentence **předá dál**, a je
 * to táž funkce, kterou používá lokální smyčka: jeden slovník, ne dva.
 *
 * Seznam nálezů se u té větve **nepřipisuje**. `rejectionSentence()` sama
 * rozhoduje, které adresy ukáže, a druhý výpis by tytéž nálezy zopakoval —
 * přesně ta vada, kvůli které níž existuje `squash()`.
 */
export function blueprintRejectionSentence(fault: BlueprintFault): string {
  if (fault.world !== undefined) {
    // ⚠ **Odmítnutý sim je jediná fáze, kde se sdílená věta nepřebírá — naměřeno
    // 5. 9. 2026.** `rejectionSentence()` u ní končí slovy „or keep declining only
    // if the request truly cannot be built", a to je na téhle cestě slepá ulička:
    // Codex tu nabídku přijal třikrát po sobě a smyčka dojela do stropu kol, aniž
    // se odpověď hnula. Lokální větev tu nabídku má právem — `NO_FIT` je tam
    // poctivá obrazovka — proto se mění tady a `local/rejection-prompt.ts` zůstává.
    //
    // Věta drží dvě věci naráz: co napsat místo odmítnutí, a **že zbytek emise
    // byl v pořádku**. Bez druhé půlky by model přepsal i geometrii, kterou
    // compiler přijal, a další kolo by opravovalo jinou vadu než tuhle.
    if (fault.world.rejection.stage === 'declined')
      return [
        `${fault.reason} · You declined to write the sim part, and this stage has no NO_FIT.`,
        'The place already stands, so write the smallest sim that fits it: whoever walks in, one',
        'socket the place already contains, and a win rule that says what reaching it means.',
        'Send back the geometry, the shapes and the placements exactly as you wrote them — they',
        'were accepted, and rewriting them costs you the only part that was already right.',
      ].join(' ');

    return `${fault.reason} · ${rejectionSentence(fault.world.rejection, fault.world.context)}`;
  }

  const extra = extraIssues(fault);
  const listed = fairShare(extra, MAX_ISSUES_IN_SENTENCE);
  const rest = extra.length - listed.length;

  const parts = [`${fault.reason} · ${fault.detail}.`];
  if (listed.length > 0) {
    // **„of the same kind" tady stálo do 9. 9. 2026 a byla to nepravda** —
    // zbytek jsou nálezy jiných adres a jiných druhů, protože se vybírá kolo
    // po kole. Věta říká jenom počet, který ověřit umí.
    const more = rest > 0 ? `; and ${String(rest)} more` : '';
    parts.push(`Also wrong, and each one on its own: ${listed.join('; ')}${more}.`);
  }
  parts.push(WHAT_TO_DO[fault.reason]);
  return parts.join(' ');
}
