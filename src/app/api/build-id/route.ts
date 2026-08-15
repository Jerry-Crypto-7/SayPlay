/**
 * `GET /api/build-id` — hash stromu, ze kterého tenhle artefakt vznikl.
 *
 * ## Co tahle routa dokazuje a co ne
 *
 * **Sama o sobě nedokazuje nic** a je důležité to říct nahlas. Kolo 2 review
 * nad T205 to formulovalo přesně: *„`GET /api/build-id` dokazuje pouze to, že
 * nasazený artefakt obsahuje očekávanou hodnotu, nikoli že jeho ostatní obsah
 * skutečně vznikl ze stromu tagu."* Identifikátor, který si artefakt sám
 * vypíše, je sebeprohlášení.
 *
 * Nosný je **směr, ze kterého ta hodnota přišla**. `scripts/build-from-tag.mjs`
 * ji odvodí z bajtů čerstvého checkoutu (`git write-tree` nad rozbaleným
 * archivem), ne z toho, co kdo o tagu tvrdí, a teprve pak ji pustí do buildu
 * jako `WORLDSMITH_BUILD_TREE`. Kdyby se opsala z `git rev-parse
 * fallback-v1^{tree}`, prošel by build libovolného checkoutu.
 *
 * ## Proč `process.env` a ne čtení souboru za běhu
 *
 * `next.config.mjs` proměnnou vystavuje přes `env`, takže webpack ji **zapéká**
 * do bundlu jako literál. Artefakt tím pádem vrací správnou hodnotu i tam, kde
 * proměnná neexistuje — a to je podmínka T205b, který nasazuje artefakt beze
 * změny, ne artefakt plus konfiguraci prostředí.
 *
 * `unbuilt` je hodnota z běžného `next build` nad pracovním stromem. Je vidět a
 * nedá se splést s hashem, takže smoke test na ni spadne hlasitě.
 */

const BUILD_TREE = process.env.WORLDSMITH_BUILD_TREE ?? 'unbuilt';

export function GET(): Response {
  return Response.json({ tree: BUILD_TREE });
}
