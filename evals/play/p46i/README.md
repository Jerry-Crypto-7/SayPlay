# P46I – modely pro prostředí her přes noc

Plán: P46I (interní). Větev `features/P46I-modely-prostredi-2026-10-14` z tipu P46F (`20443ec1`), slučuje se po P46F.

## Cíl

Aspoň **120 nových modelů** v katalogu a každé zpracované prostředí s **≥ 3 rekvizitami**. Rekvizity prostředí (`src/play/arcade/look/setting-kits.json`) vidí každá hra s tím prostředím; slepý soud P46G vyhrál právě hustotou a čitelností místa. Chybějící slova z vět jsou vyčerpaná (`still-missing.mjs` nad P46F vrací jen šum).

Mimo: `src/play/**` kromě regenerace `setting-kits.json` skriptem, `src/components/**`, placená API, zapečetěné sady, hrdinové (mění manifest `src/play`).

## Seznam (`round-nouns.json`)

Prostředí se počítají na integrační větvi P46 (91 prostředí, nese kity P46G, které tahle větev nemá): 20 z nich má dnes ≥ 3 rekvizity.

1. **Nejdřív modely, které katalog už má** – 118 párů prostředí → model v `kit-nouns.json` (`source: p46i-catalog`), bez generování. Samy zvednou prostředí s ≥ 3 rekvizitami z 20 na 80 z 91.
2. **Nová jména pro prostředí** – `kit-1` (prostředí s 1 rekvizitou, 21 jmen) a `kit-2` (se 2, 12 jmen), vždy jen do 4 rekvizit na prostředí. Po povýšení všech: 86 z 91.
3. **Scenérie základních sad vzhledu** – `scenery`, 108 jmen pro 18 sad z `look/index.ts`, po jednom na sadu dokola. Jen modely; zapojení do sad navrhne souhrn (T3), `src/play/**/*.ts` se nemění.
4. **Zbytek P46F** – 31 nezkoušených jmen fronty (`totem pole` vypadlo: integrační větev má `tribal totem pole`), pak 20 jmen, která v P46F neprošla, s jedním opakováním (semínka `a2,b2,a3`).

Celkem 192 jmen (172 prvních pokusů + 20 opakování P46F); s jedním opakováním na jméno až 364 pokusů.

Pravidla seznamu (kontroluje `D:/caches/p46i/build-t1.mjs`):
- žádné jméno ani synonymum se slovem třídy manifestu `scripts/assets/p32-manifest.mjs`;
- žádné jméno ani synonymum, které má katalog této větve nebo větví P46 (štítek, id, synonymum P37D);
- žádné jméno končící na „s“ – `cache.slug` ho zkrátí a id `gen3d-<jméno>` by nesedělo s kitem;
- každé nové jméno má rozlišovací znak v `ops/gen3d/features.toml`, klíč není na větvích P46 (duplicitní klíč TOML po sloučení);
- prostředí, která `src/play/__tests__/look.test.ts` připíchl přesným seznamem (frozen lake, highway, supermarket, canyon, desert canyon, haunted mansion), nedostanou nic.

## Jak se páry dostanou do hry

`scripts/p45h/build-setting-kits.mjs` čte za `evals/play/p45g/kit-nouns.json` i `evals/play/p46i/kit-nouns.json` a výšku kulisy bere z pole `height`. Do tabulky jde jen povýšený model `gen3d-<jméno>` bez `qa:unrecognisable`, takže nové jméno se objeví až po povýšení – smyčka po každém kole skript pustí znovu. Při sloučení s integrační větví se `setting-kits.json` nesloučí ručně, ale vygeneruje znovu.

## Pravidla běhu

- RTX 3090, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Mezipaměť `D:/claude/_gen3d-cache-p46i`, záznam dávek `D:/caches/p46i/round<n>/`.
- **Soudce i předkontrola obrázku = Codex** (`--judge codex`), slepě v prázdném `mkdtemp` jen se `sheet.png`. Strop celého P46I **1500 volání**. Vyčerpaný limit = soubor `LIMIT`, nová dávka se nespouští, soud se zkouší každých 10 minut.
- Po povýšení: vyřazení jmen, která by vzal manifest `src/play`, regenerace tříd pohybu a `setting-kits.json`, sady `src/assets`, `scripts/p37d`, `scripts/assets` a připíchnuté testy `src/play` (včetně `look.test.ts` a `setting-ground.test.ts`). Červené → `promote-batch.mjs --drop` a záznam. Sady počkají, když worktree P46-hratelnost, P46G nebo P46H pouští vitest nebo build.
- license-gate: nové GLB v `public/` a jejich záznamy v `disclosure.json` v tomtéž commitu, jeden commit na dávku.
- **Okno:** po **15. 10. 2026 08:45** se nová dávka nespouští; souhrn nejpozději v 09:15.

Záznam po kolech: `gen-round.md`.
