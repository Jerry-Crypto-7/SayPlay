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

## Po T2 (pravidla rychlé verze místo hry bez pravidel; tytéž nahrávky, `baseline.json` nepřepsaný)

- **AI verze vyjde u 23 z 25** (92 %). h09, s003 a u47 už nepadnou na `ACTION_LOST`: hra režiséra s pravidly rychlé verze akci z věty drží. Nečitelné zůstávají d20 a s056.
- **Pravidla i logiku drží 23 z 23 `ready` (100 %).** Bez pravidel nevyjde žádná, m10 má obě pravidla.
- **Novinku, kterou hráč hraje, nepřidá žádná** (0 z 23). Boss u s002 byl jen ve hře bez pravidel; s pravidly rychlé verze zmizí. Bosse režiséra přinese T4 jako vlastní pole odpovědi. Jen postavy přidá 12 z 23.

## Po T5 (nové nahrávky s bossem, akcemi a úseky; `after.json`)

**Věty** (`sentences.json`): 8 her majitele z 12. 10. (o01–o08; přesné znění včely se nezapsalo, stojí za ni věta včely z P46C) a 17 vět panelu P45. Žádná ze zapečetěné sady.

**Nahrávky** (`src/play/director/__fixtures__/p46-answers/`): gpt-oss-20b lokálně (stejný model jako režisér dema na Groq), jedna první odpověď na větu, 4–16 s. Nahrát znovu (pod zámkem GPU):

```
node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p46e/record.cmd
```

`record.cmd` pouští nahrávač P45B s jinou sadou (`P45B_SENTENCES`, `P45B_ANSWERS`, `P45B_OUT`). Vedlejší `director-logic.json` je soud logiky P45B nad týmiž odpověďmi (logiku s `logic_proved` napíše 4 z 25). Měření: `P46E_ANSWERS=src/play/director/__fixtures__/p46-answers P46E_OUT=evals/play/p46e/after.json` a příkaz výš. Offline přehrání hlídá `src/play/director/__tests__/p46-fixtures.test.ts` (každá nahrávka dá svůj řádek `after.json`).

**První nahrávka s promptem T3** (řádek „NEW IN YOUR VERSION (else null)“, jeden příklad): model klíče napsal, ale skoro vždy prázdné – boss 0 z 25, akce 2, úseky 2. Proto podle plánu příklad na každý ze 3 hlavních žánrů (běžec, řízení, skákačka) a bez „else null“. Druhá úprava promptu se nedělá.

**S novým promptem** model vyplní bosse u 15 z 25, úseky u 16 a akce u 6. Výsledek (`after.json`):

| Cíl | Hodnota | Splněno |
|---|---|---|
| `ready` ≥ 80 % | 25 z 25 (100 %) | ano |
| `keptRules` / `keptLogic` 100 % | 100 % / 100 % | ano |
| králík (o01) a muchomůrky (o02) ready | obě ready | ano |
| `adds` ≥ 80 % z ready | 4 z 25 (16 %) – jen boss (f03, f10, j08, s021) | **ne** |

**Proč se novinky ztratí** (sonda nad o01–o04, fakta z `direct()`):

- Hra režiséra ztrácí akci věty (`ACTION_LOST: rabbit escape fox has no action witness`) nebo její pravidla neprojdou (`RULE_INVALID: no rule enters phase mid` u obou aut). Upgrade pak vezme kandidáta s pravidly rychlé verze (`withDraftRules`, novinky odpovědi nese) nebo roub na rychlou hru (`onQuickGame` staví z rychlé verze, bosse, akce ani úseky odpovědi nenese). Který kandidát u které věty vyhrál, měřidlo nezapisuje.
- Aréna (10 z 25 odpovědí) průběh nemá, takže boss a úseky se v ní nepostaví (T4, `withBuiltExtras`).
- Akce režiséra robot ve výsledné hře nepoužije, nebo s ní nevyhraje – `action` 0 z 25.
- **Odvozeno, neověřeno:** největší páka je přenést bosse, akce a úseky odpovědi i na roub `onQuickGame` a zapsat do řádku měřidla, který kandidát vyhrál. Hra rychlé verze (běžec, řízení, skákačka) je umí postavit a robot ji vyhrává.

**Oprava cestou** (`_upgrade.ts`): kandidát ověřený na prvním seedu se publikuje na prvním seedu, který drží akci věty. Když se liší, ověří se znovu i roub. Králík s touto nahrávkou předtím skončil `NOT_PLAYABLE` při publikaci.
