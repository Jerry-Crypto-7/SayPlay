/**
 * Tier politika certifikace — **horizont deklaruje systém, ne model**.
 *
 * `DESIGN-BOOK.md` §6 je v tomhle bodě kategorický: *„Kdyby si ho deklaroval
 * model, projde verifikací triviálně: prohlásí horizont tak dlouhý, že vyhraje
 * i náhodná procházka."* Bez `H_cert` / `L_witness` / `K_input` je garance §6
 * formálně pravdivá a produktově bezcenná.
 *
 * Dokument proto smí o tier **požádat**; co z té žádosti platí, rozhoduje tahle
 * tabulka. Neexistuje cesta, kterou by si žádost horizont zvedla: `resolvePolicy`
 * vrací buď politiku tieru, o který se žádá, nebo `null` — nikdy tier povýšený
 * podle přání dokumentu.
 *
 * **`K_input` je jediná obrana proti dlouhé, náhodně vypadající stopě.** Věta
 * o dosažitelnosti sama o lidské hratelnosti neříká nic; design book výslovně
 * varuje před tím, ji nahradit předstíráním, že říká.
 *
 * **Čísla jsou odhad a musí se přeměřit** — vazba na
 * `plans/P7-brany-a-evaluace.md` (§18 #4). Odvozená jsou z 20 Hz (`VERIFY.md`
 * §3.3): 600 tiků = 30 s, 1 200 = 60 s, 3 600 = 180 s.
 */

export const TIERS = ['short', 'standard', 'long'] as const;

export type Tier = (typeof TIERS)[number];

export interface TierPolicy {
  readonly tier: Tier;
  /** Strop certifikačního horizontu v **ticích**, ne v sekundách. */
  readonly maxHorizonTicks: number;
  /** Strop počtu kanonických vstupů ve svědkovi — `K_input`. */
  readonly maxInputs: number;
}

export const TIER_POLICY: Readonly<Record<Tier, TierPolicy>> = {
  short: { tier: 'short', maxHorizonTicks: 600, maxInputs: 32 },
  standard: { tier: 'standard', maxHorizonTicks: 1_200, maxInputs: 64 },
  long: { tier: 'long', maxHorizonTicks: 3_600, maxInputs: 128 },
};

/** O co dokument žádá. Je to **žádost**, ne deklarace — autoritou je `TIER_POLICY`. */
export interface CertificationRequest {
  readonly tier: Tier;
  readonly horizonTicks: number;
}

/** Bez vlastní žádosti se certifikuje nejkratším tierem, ne nejdelším. */
export const DEFAULT_REQUEST: CertificationRequest = {
  tier: 'short',
  horizonTicks: TIER_POLICY.short.maxHorizonTicks,
};

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/**
 * Politika pro danou žádost, nebo `null` = `NO_FIT`.
 *
 * `null` je jediná odpověď na horizont nad stropem tieru. **Povýšení do delšího
 * tieru se tu nekoná** — to by z modelu udělalo autoritu nad tím, jak dlouho se
 * smí hledat výhra, což je přesně ta chyba, kterou §6 zakazuje. Kdo chce delší
 * horizont, žádá rovnou o delší tier a nese jeho `K_input` strop.
 */
export function resolvePolicy(request: CertificationRequest): TierPolicy | null {
  if (!isTier(request.tier)) return null;
  if (!Number.isInteger(request.horizonTicks) || request.horizonTicks < 1) return null;
  const policy = TIER_POLICY[request.tier];
  return request.horizonTicks > policy.maxHorizonTicks ? null : policy;
}

/**
 * Nejmenší tier, který by daný horizont unesl — **systémové** doporučení pro
 * autora světa. Vrací `null`, když je horizont nad stropem i toho nejdelšího;
 * takový svět se musí zkrátit, ne dostat výjimku.
 */
export function smallestTierFor(horizonTicks: number): Tier | null {
  if (!Number.isInteger(horizonTicks) || horizonTicks < 1) return null;
  for (const tier of TIERS) if (horizonTicks <= TIER_POLICY[tier].maxHorizonTicks) return tier;
  return null;
}
