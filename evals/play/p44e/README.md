# P44E – měření viditelnosti

## Zapečetěná sada

`sealed-200.json` vytvořil nezávislý autor bez přístupu ke kódu a předchozím
testovacím sadám. Obsahuje 200 anglických vět, 118 hrdinů a 251 položek
`role`/`any`; štítky: 48 `non-game`, 126 `unknown-verb`, 41 `fantasy`.
Každá věta má právě jedno sloveso a 2–4 podstatná jména.

SHA-256 nad UTF-8 bajty po normalizaci CRLF na LF:
`ff6d914c594a75b7302fe9f6521f9a770b8fb2dfdc33834cb48c0a7a70884481`

Sadu zpřístupní pouze `--set p44e-sealed --open-sealed-once`; otevření zapíše
`sealed-opened.json` a další otevření odmítne. Validační test používá dočasné
pečetě mimo repozitář a porovnává pouze otisky vět, nikoli jejich výpis.
