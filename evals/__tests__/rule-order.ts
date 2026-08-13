/**
 * Kanonické pořadí pravidel — deklarované ve zmrazeném `evals/frozen/MANIFEST.lock`
 * (`rulesShapeRule`): *„pořadí klíčů je pořadí vykonání podle (phase, priority, ruleId)"*.
 *
 * **Proč to potřebuje vlastní oracle — a proč to NENÍ ztráta sémantiky.**
 * Přemrazení na v2 udělalo ze `sim.rules` ZÁZNAM. `canonical()` (`src/ir/worlddoc.ts`)
 * klíče objektů řadí, takže pořadí klíčů do `simHash` nevstupuje, zatímco u pole
 * vstupovalo. Brána nad T2b z toho vyvodila, že v2 dovolí dvěma sémanticky různým
 * dokumentům sdílet jeden hash. **Ta úvaha neplatí a měření to ukazuje:** pořadí
 * vykonání je ODVOZENÉ z `phase`, `priority` a `id`, všechna tři pole nese každé
 * pravidlo v korpusu (31/31 v odpovědích i ve vadných emisích) a všechna tři se
 * hashují. Pořadí klíčů je jeho vykreslení, ne nezávislý nosič významu — dva
 * dokumenty lišící se jen jím jsou týž svět a stejný hash mít MAJÍ.
 *
 * **Co ale opravdu odpadlo, je vynucení toho vykreslení.** Dokud bylo `rules` pole,
 * hlídal ho hash mimochodem. Od v2 ho nehlídá nic, a bez toho je třída defektu
 * `non_canonical_order` neměřitelná čímkoli navázaným na `simHash` — M05 je pod v2
 * bajtově shodná před i po vlastní deklarované opravě. Tenhle modul je ten chybějící
 * oracle a jeho jednotkou je **pořadí klíčů**, ne hash. Scorer z T15/T16 musí třídu
 * `non_canonical_order` soudit odsud, ne z `simHash`.
 *
 * Soubor záměrně nekončí na `.test.ts`, takže ho vitest nesbírá jako sadu
 * (`vitest.config.mts` omezuje `include` na soubory s touhle příponou) — je to
 * sdílený oracle pro dvě sady nad zmrazeným korpusem.
 */

export interface OrderedRule {
  phase?: unknown;
  priority?: unknown;
}

export type RuleRecord = Record<string, OrderedRule>;

/**
 * Nese každé pravidlo obě řadicí pole jako konečné číslo? Bez toho je pořadí
 * vykonání nedefinované a `canonicalRuleOrder` by řadilo podle `NaN`, což je
 * v JS tichý no-op — kontrola by prošla a neznamenala nic.
 */
export function carriesOrderKeys(rules: RuleRecord): boolean {
  return Object.values(rules).every(
    (r) => Number.isFinite(r.phase as number) && Number.isFinite(r.priority as number),
  );
}

/** Klíče v pořadí `(phase, priority, ruleId)`. */
export function canonicalRuleOrder(rules: RuleRecord): string[] {
  return Object.entries(rules)
    .slice()
    .sort(([keyA, a], [keyB, b]) => {
      const phaseA = a.phase as number;
      const phaseB = b.phase as number;
      if (phaseA !== phaseB) return phaseA - phaseB;
      const prioA = a.priority as number;
      const prioB = b.priority as number;
      if (prioA !== prioB) return prioA - prioB;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    })
    .map(([key]) => key);
}

/** Je pořadí klíčů to deklarované? Těla s jedním pravidlem porušit nejde. */
export function isCanonicallyOrdered(rules: RuleRecord): boolean {
  const actual = Object.keys(rules);
  const expected = canonicalRuleOrder(rules);
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/**
 * Vytáhne z těla `sim.rules` jako záznam — nebo `null`, když tam žádný není.
 * Pole vrací `null` schválně: tvar hlídají jiné aserce a tenhle oracle o pořadí
 * klíčů nad polem nemá co říct.
 */
export function ruleRecordOf(body: unknown): RuleRecord | null {
  const sim = (body as { sim?: { rules?: unknown } } | null)?.sim;
  const rules = sim?.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  return rules as RuleRecord;
}
