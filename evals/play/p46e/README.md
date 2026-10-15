# P46E – měřidlo AI verze

Majitel 12. 10. 2026: „AI verze nic nepřidá“. Měřidlo říká číslem, jestli AI verze vyjde, jestli nezahodí pravidla a logiku rychlé verze a co hráči přidá.

## Co měří

- **Cesta** (`upgrade.ts`): rychlá verze se publikuje jako v `POST /api/play/games` (návrh z věty, semínka z věty), nad ní běží skutečný `directUpgrade` a v něm `direct()` kompaktního režiséra s ověřením robotem. Jediný dvojník je větev modelu: vrátí nahranou první odpověď. Opravné kolo se nevolá, nahrávka je jedna odpověď.
- **`status`**: `ready` = AI verze publikovaná, jinak `draft-final` s důvodem (`MALFORMED`, `ACTION_LOST`, …). `directed` je výsledek `direct()` před bránou upgradu (`authored` = hra z odpovědi).
- **`keptRules` / `keptLogic`** (jen u `ready`): AI verze má pravidla, když je měla rychlá verze, a blok `logic`, když ho měla rychlá. `rules` ukazuje počty obou.
- **`adds`** (jen u `ready`), čteno z publikovaných světů, ne ze jmen:
  - `boss` – boss finále, který rychlá verze neměla, nebo jiný model bosse,
  - `action` – tlačítko akce (P46A) nebo akce ze seznamu `ABILITIES`, kterou robot udělal a rychlá verze ne,
  - `segments` – neprázdný scénář úseků 2 a 3 (`segmentNewsOf`), jiný než u rychlé verze,
  - `characters` – nové jméno role. **Není to novinka ve hře**: AI verze, která přidá jen postavy, se do podílu `adds` nepočítá (`onlyCharacters`).

## Spuštění

```
npx vitest run --config vitest.measure.mts evals/play/p46e/upgrade.measure.ts
```

Bez proměnných čte `src/play/director/__fixtures__/logic-answers` (25 nahraných odpovědí gpt-oss-20b z P45B) a zapíše `baseline.json`. Jiná sada: `P46E_ANSWERS=<složka> P46E_OUT=<soubor>`. Běh trvá ~4,5 min. Výstup nemá čas, takže nový běh bez změny kódu nechá git čistý.

## Výchozí stav (`baseline.json`, větev P46E z P46 `72792345`)

- **AI verze vyjde u 20 z 25** (80 %). `direct()` dá hru z odpovědi u 23 z 25. Commit `aed3ebee` psal „22 z 25 před bránou upgradu“; dnešní obdoba je těch 23. Rozdíl je jedna věta a vznikl až po `aed3ebee` (P46A–I změnily hry, které robot ověřuje). Za branou upgradu padnou 3 (`ACTION_LOST`: h09 nemocnice, s003 křeček, u47 plavčík) a 2 odpovědi se nedají přečíst (`MALFORMED`: d20 jednorožec, s056 skútr).
- **Pravidla drží 15 z 20 `ready` (75 %), logiku 14 z 20 (70 %).** Bez pravidel vyjdou pa-017, pa-018 (vesmírná loď), s002 (rytíř a klíče), s008 (banán) a si-018 (poušť). U m10 (hasič) zůstane jedno pravidlo ze dvou a logika zmizí. Pravidla ztrácí `direct()` (záloha bez pravidel, nebo odpověď bez nich a `read.ts` zahodí logiku); roub `onQuickGame` pravidla rychlé verze drží, když AI žádná nenapsala (z kódu, po větách neověřeno).
- **Novinku, kterou hráč hraje, přidá 1 z 20** (5 %): boss u s002. Akce ani vlastní úseky nepřidá žádná. Jen postavy přidá 10 z 20 a zbylých 9 nepřidá nic.
