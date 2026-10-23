# P58C T3 – hlavní cesta na Safari a iPhonu (WebKit)

Běh 23. 10. 2026 nad produkčním buildem (`npm run build` + `node node_modules/next/dist/bin/next start --port 3187`, čisté úložiště her), `FALLBACK_SMOKE_URL=http://127.0.0.1:3187`, Playwright 1.62.1, WebKit 26.5 (`webkit-2336`) na Windows 11.

```powershell
npx playwright install webkit
npx playwright test --project=webkit-desktop --project=iphone-touch
```

- **`webkit-desktop`** (Desktop Safari 1280×720): `play-create`, `play-chain`, `p36-dare`, `p44b-friends-loop`.
- **`iphone-touch`** (iPhone 15, dotyk): `play-create`, `play-touch`, `play-chain`, `p36-dare`.

## Výsledek

**25 prošlo, 17 padá** (`webkit-desktop` 13/19, `iphone-touch` 12/23), 5,7 min. Tytéž soubory na Chromiu 19/19 a Pixelu 7 6/6 ve stejném buildu – **všech 17 pádů je jen WebKit**.

| Příčina | Pády | Druh |
|---|---|---|
| A. Věta napsaná před hydratací zmizí | 9 | chyba produktu |
| B. Dotyk přes CDP | 5 | chyba testu |
| C. První hratelný snímek 2,4 s | 2 | měření, viz C |
| D. Desktopové rozložení na profilu telefonu | 1 | chyba testu |

## Co padá a proč

### A. Věta napsaná před hydratací zmizí – chyba produktu

**Pády:** `play-create` „hero, typed sentence and Make it!“ (desktop), „denied topic“, „refused sentence“, „offline“ (desktop i iPhone), „four build steps“ (iPhone), `p44b-friends-loop` (desktop).

**Fakt (sonda `Make it!` hned po `goto`, 23. 10.):** WebKit odešle formulář (`submit` přijde), ale pole je v tu chvíli prázdné (`value: ""`), stránka ukáže „Add who you are…“ a `POST /api/play/games` neodejde vůbec. Chromium ve stejné sondě pošle POST. Když sonda počká na `networkidle`, WebKit POST pošle a přejde na `/play/<id>`.

**Inference:** WebKit dostane stránku interaktivní později (načtení 1,2–3,9 s proti 0,9–1,1 s v Chromiu) a text napsaný do `<textarea>` před hydratací Reactu se pak přepíše prázdným stavem `sentence` z `CreateGame.tsx`. Hráč na pomalém iPhonu, který začne psát hned, o větu přijde. Chybové testy (zákaz tématu, odmítnutí, offline, kroky stavby) padají proto, že bez POSTu nemají co ukázat – samostatně je každý neověřený. Test s kartou nápadu a Enterem prošel, protože karta plní pole až po hydrataci.

**Kam v T4:** `src/components/play/CreateGame.tsx` – převzít hodnotu pole, kterou hráč napsal před hydratací, nebo pole do hydratace zamknout. Test: napsat před hydratací, ověřit odeslanou větu.

### B. Dotyk přes CDP – chyba testu

**Pády:** `play-touch` „won with gestures alone“ ×5 (runner, platformer, arena, quest, voyage) na iPhonu.

**Fakt:** `browserContext.newCDPSession: CDP session is only available in Chromium` (`e2e/play-touch.spec.ts:169`). Třída `Fingers` posílá prsty přes CDP `Input.dispatchTouchEvent`, které WebKit nemá. Hra se na iPhonu otevřela a plocha ukázala správné `data-control`, do gest test vůbec nedošel.

**Kam v T4:** pro WebKit poslat prsty jinou cestou (WebKit má `Touch` i `TouchEvent` konstruktory, `page.touchscreen` umí jen ťuk). Až pak bude vidět, jestli gesta na Safari fungují.

### C. První hratelný snímek 2,4 s – měření

**Pády:** `play-chain` na obou projektech: první vstup kola 1 za **2 446 ms** (desktop) a **2 463 ms** (iPhone) od navigace, strop 1 500 ms. Chromium tentýž test splní.

**Fakt:** test pozná telefon podle jména projektu (`pixel7-touch`), takže `iphone-touch` bere jako desktop – mačká mezerník a měří proti desktopovému stropu. Zbytek řetězu (karta slovesa, kola, srdce, hvězdy, výzva) se kvůli tomu neprověřil.

**Inference:** WebKit na Windows kreslí přes windowsovou grafickou cestu (renderer se jen maskuje jako „Apple GPU“), takže 2,4 s nemusí platit pro Safari na Macu ani iPhonu. T4 má nejdřív test naučit poznat telefon podle dotyku, pak rozhodnout, jestli strop platí i pro WebKit, nebo jen zapisuje.

### D. Desktopové rozložení na profilu telefonu – chyba testu

**Pád:** `play-create` „desktop 1440×900: the sentence field sits in the left column beside the feed“ na iPhonu – `.play-pager` nemá rozměr (`boundingBox()` = `null`).

**Inference:** profil iPhonu je mobilní (`isMobile`), změna velikosti okna z něj desktop neudělá. Test patří jen na desktop; v T4 ho z `iphone-touch` vyřadit (`grepInvert`), ne opravovat produkt. Rozměr 1024×768 na iPhonu prošel.

## Co prošlo

- **Výhra a výzva:** `p36-dare` 4/4 na obou projektech – vyhraný běh sdílí odkaz se skóre, které server přehrál; odmítnutá výzva sdílí čistý odkaz; hráč B vidí cíl přítele, prohraje („So close.“), vyhraje („You beat it!“) a pošle výzvu zpět; neznámá výzva otevře hru bez chyby. Hra běží ve WebGL2.
- **Tvorba:** domovská adresa vede na `/play`, karta nápadu + Enter vytvoří hru, prázdné pole i počítadlo 0/140, `Surprise me`, lišta Make/Play na telefonu, desktopové rozložení na desktopu.
- **Na iPhonu i „Make it!“** (`play-create` „hero, typed sentence“) – tady hydratace závod vyhrála.

## Co emulace nepokryje

Sonda schopností prohlížeče 23. 10. (Playwright WebKit na Windows proti Chromiu):

| Schopnost | WebKit (desktop i iPhone profil) | Chromium | Skutečné Safari |
|---|---|---|---|
| WebGL2 | ano | ano | ano |
| `AudioContext` (zvuk) | **ne** | ano | ano |
| `MediaRecorder` + `captureStream` (klip) | **ne** | ano, MP4 i WebM | ano, MP4 |
| `navigator.share` (sdílení) | **ne** | ne | ano, po gestu |
| `navigator.deviceMemory` | ne | 32 | ne |
| WebGPU | ne | ano | jen novější verze |

- **Zvuk, klip a nabídka sdílení se na WebKitu pod Windows ověřit nedají** – build Playwrightu je nemá. Kód je hlídá (`typeof AudioContext`, `clipType`, `typeof navigator.share`), takže pády nezpůsobují; jestli na iPhonu hrají, ukáže jen skutečný telefon (P59).
- **`deviceMemory` chybí i ve skutečném Safari** – `src/worldstream/quality.ts` s tím počítá (pole je volitelné), emulace tady odpovídá realitě.
- **Grafika:** WebKit na Windows není Metal na iPhonu; časy snímků a vzhled tady jsou jen orientační.

## Pro T4

1. A – převzít větu napsanou před hydratací (`CreateGame.tsx`), test na WebKitu.
2. B – prsty pro WebKit v `play-touch`, pak teprve hodnotit gesta.
3. C – telefon podle dotyku v `play-chain`, rozhodnout strop pro WebKit.
4. D – `grepInvert` desktopových rozměrů v `iphone-touch`.
