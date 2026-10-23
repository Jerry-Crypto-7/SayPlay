# P58C T5 – prvních 10 s porotce (23. 10.)

`node scripts/p58c/first-impression.mjs --runs 3` nad `next start` (build `f5864212`), data `first-impression.json`, listy `first-impression/*.jpg`.

## Výsledek

- **Rychlost není ztráta.** Medián 3 studených běhů: první obsah do 0,5 s, první funkční ťuk do 0,5 s, „Make it!“ → první přijatý vstup hry 0,9 s (Pixel 7), 2,1 s (desktop), 2,9 s (iPhone/WebKit na Windows).
- **Porotce ztrácí čas tím, že neví, jak hrát.** Všichni tři soudci na všech třech profilech jmenovali ovládání.
- **Rozumím, co dělat (do 2 s):** Pixel 7 2/3, iPhone 2/3, desktop 3/3 – „ne“ dal Codex na obou telefonech (stránka neříká, že z věty vznikne hra).

## Měření (p50 ze 3 běhů, ms)

| Profil | První obsah | První funkční ťuk | „Make it!“ → hra přijme vstup |
|---|---|---|---|
| Pixel 7 (Chromium s grafikou) | 484 | 355 | 870 |
| iPhone 15 (WebKit na Windows) | 165 | 465 | 2 867 |
| Desktop Chrome 1280×720 | 524 | 393 | 2 092 |

## Tři největší ztráty (sekundy odhadnuté soudci, sečtené přes soudce a profily)

1. **Ovládání není vidět – 37 s, 3/3 soudci, všechny profily.** Na telefonu přepínač Quick/Full detail leží přes tlačítka Dodge a Strike (snímek 3 obou telefonů); pokyn nahoře je useknutý „…“. Na desktopu chybí čitelné klávesy, jen drobná karta „Tap to start“, a po stisku mezerníku se scéna 5 s nehne (časovač 0,0 s).
2. **Prohra dřív, než porotce pochopí hru – 11 s, 3/3 soudci (telefony).** Pixel 7: „So close.“ po 4,8 s, 2 % cesty; iPhone ze 3 srdcí na 1 za 5 s. Soudci: „umřel jsem dřív, než jsem zjistil, jak uhnout“.
3. **„Make it!“ není na první obrazovce telefonu – 7 s, 2/3 soudci.** Karta říká „Tap one, then Make it!“, ale tlačítko je pod pěti kartami; dole je jen lišta „Make / Play“. Na desktopu žluté „Tap to play“ hry ve feedu přebíjí „Make it!“.

Další: dlouhé věty karet (6 s), stránka neříká, že z věty vznikne hra (4 s, Codex), prázdný tmavý panel hry ve feedu na desktopu v 0,7 s (2,5 s).

## Navržená brána (v `first-impression.json` → `gate`)

- **Soudci „rozumím, co dělat“ 3/3 na každém profilu** (dnes 2/3 na obou telefonech).
- **Ovládání:** kategorii `unclear-controls` jmenuje nejvýš 1 soudce na profil (dnes 3/3) – kontrola ručně z JSONu.
- **Časy se nezhorší:** p50 první obsah a první ťuk ≤ 1 s; „Make it!“ → vstup ≤ 1,5 s Pixel 7, ≤ 2,5 s desktop, ≤ 3,5 s WebKit.
- Kontrola po T6: `--gate-from evals/play/p58c/first-impression.json --out evals/play/p58c/first-impression-after.json` (časy a „rozumím“ strojově).

## Jak se měří (a co to zkresluje)

- **Studený běh** = nový kontext prohlížeče (prázdná cache, první návštěva); server se předem zahřeje, aby se neměřilo líné první sestavení stránky v `next start`.
- **Film:** každý snímek (0,4–0,7 / 2 / 5 / 10 s) z vlastního studeného běhu se stejným rozvrhem „rychlého porotce“: čte 2 s, ťukne na první kartu, za 0,5 s „Make it!“, pak ťuká (desktop mezerník) každých 0,8 s. Jeden snímek na běh, protože snímek i video stránku zdrží o sekundy.
- **Chromium s grafickou kartou** (jako `time-to-playable.mjs`). Bez ní stránka s hrou ve feedu klik i snímek dusí na sekundy. Pixel 7 bez zpomalení CPU jako `p56b-first-frame`; 4× z `p35-perf` natáhlo start na 21 s, 40 s a přes minutu – měřilo softwarovou grafiku, ne telefon.
- **iPhone = WebKit na Windows.** Film běží při hustotě 1, protože tento WebKit po zmenšení plátna přestane plátno ukazovat (`webkit.md`). Časy jsou jen orientační.
- **Stav AI verze ve filmu odpovídá „pracuji“.** Lokální server bez modelu by verzi hned vzdal a ukázal toast „Couldn't make the full-detail version“, který porotce na nasazení v prvních 10 s nevidí.
- **Inference:** ztráta 2 (rychlá prohra) je zčásti dílem skriptu – ťuká doprostřed, neuhýbá. Skutečný porotce prohraje později, ale hra mu také neřekne, co ho zasáhlo.
