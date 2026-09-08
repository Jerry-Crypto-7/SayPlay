/**
 * Adresa nasazeného artefaktu, proti kterému se sada pouští — nebo `undefined`.
 *
 * **Jedno čtení pro dva čtenáře, a to je celý smysl téhle funkce.**
 * `playwright.config.ts` tutéž proměnnou soudil pravdivostně
 * (`target ? undefined : webServer`), kdežto `e2e/worldstream-session.spec.ts`
 * porovnáním s `undefined`. Na `FALLBACK_SMOKE_URL=""` se ti dva čtenáři
 * rozešli: config nastartoval lokální server, spec se přesto celý přeskočil, a
 * běh skončil **zeleně, aniž cokoliv dokázal**. Nález nezávislé revize
 * 2. 9. 2026.
 *
 * Dva jednoslovné patche by je srovnaly jen do dnešního dne — pořád by to byla
 * dvě nezávislá rozhodnutí o jedné proměnné, tedy přesně ten tvar vady, který
 * se tu opravuje. Proto jedno místo, které to rozhoduje, a oba čtenáři z něj.
 *
 * Prázdný řetězec znamená **nenastaveno**, nikdy „nasazeno na adresu ''".
 */
export function deployedTarget(): string | undefined {
  return process.env.FALLBACK_SMOKE_URL || undefined;
}
