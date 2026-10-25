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

## Po T6 (23. 10., build `8f5c46bf`, `first-impression-after.json`, listy `first-impression-after/*.jpg`)

Opravy: `46039323` přepínač verze nad zónami Dodge/Strike + karta „Tap to start“ vedle hrdiny na desktopu · `49a3a8b3` po prohře do 10 s karta zopakuje nápovědu hry · `f5e91311` „Make it!“ a podtitul na první obrazovce telefonu · `8f5c46bf` cíl na telefonu na dva řádky místo výpustky.

| | Před (T5) | Po (T6) |
|---|---|---|
| Rozumím do 2 s – Pixel 7 / iPhone / desktop | 2/3 · 2/3 · 3/3 | **3/3 · 3/3 · 3/3** |
| Ovládání nejasné (soudci na profil) | 3 · 3 · 3 | 3 · 3 · 3 (brána ≤ 1 **nesplněná**) |
| Ztráta „ovládání“ celkem | 37 s | 27 s |
| p50 „Make it!“ → vstup – Pixel 7 / iPhone / desktop | 0,9 · 2,9 · 2,1 s | 1,8 · 1,0 · 2,4 s (Pixel 7 > 1,5 s) |

- **Čím si soudci stěžují teď (jiné než v T5):** nevidí, kdy hydra napřahuje a kdy je otevřená (hydra je drobný červený obrys), tip „Tap right to strike, tap left to dodge“ chtějí před bojem, ne až po prohře; na desktopu po startu žádné klávesy (karta zmizí prvním stiskem). Na iPhonu karty nápadů teď leží pod lištou Make/Play.
- **Časy:** stroj při měření 96–100 % CPU (74 procesů node jiných běhů). Prokládané A/B starý build T5 (3188) × nový (3187), 2 kola po 3 bězích: desktop 2,47 × 2,50 s, Pixel 7 2,29 × 3,07 s (rozptyl 1,0–5,4 s), iPhone 6,4 × 5,0 s. **Inference:** starý build bránu pod stejnou zátěží nesplní taky, měřitelné zhoršení opravami není; mez 1,5 s Pixel 7 je potřeba přeměřit v klidu.

## Po T6b (24. 10., dvě měření: `first-impression-t6b.json` build `210a6fe0`, `first-impression-t6b2.json` build `bb5dc7cf`)

Opravy: `1815aa5e` štítek kitu nad soupeřem „Dodge!“ 0,5 s před zásahem a „Strike!“ v mezeře (kdo jen poslouchá povely, vyhraje bez zásahu – `duel.test.ts`) · `210a6fe0` zóny Dodge/Strike visí celý souboj, na desktopu s klávesami Down/Space, žádaná zóna svítí žlutě · `bb5dc7cf` soupeř s modelem už nemá ruku z kvádru (u malé hydry stála jako tyč, soudci v měření 1 „red stick“, „pillar … missing model“).

| | Po T6 | T6b měření 1 | T6b měření 2 |
|---|---|---|---|
| Rozumím do 2 s – Pixel 7 / iPhone / desktop | 3/3 · 3/3 · 3/3 | 3/3 · 3/3 · 3/3 | **3/3 · 3/3 · 3/3** |
| Ovládání nejasné (soudci na profil) | 3 · 3 · 3 | 3 · 3 · **1** | 3 · **1** · 3 (brána ≤ 1 **nesplněná**) |
| Ztráta „ovládání“ celkem | 27 s | 15 s | 15 s |
| p50 „Make it!“ → vstup – Pixel 7 / iPhone / desktop | 1,8 · 1,0 · 2,4 s | 2,5 · 2,8 · 2,4 s | 1,8 · 0,8 · 2,0 s |

- **Co soudci teď vidí:** zóny s klávesami („Dodge and Strike are labeled“, „Dodge Down / Strike Space are visible“) a v měření 1 na iPhonu štítek „Dodge!“. Ztráta „ovládání“ klesla z 27 s na 15 s, ale počet soudců, kteří ji jmenují, skáče mezi měřeními (desktop 1 → 3, iPhone 3 → 1) při stejném chování desktopu.
- **Proč telefon bránu nesplní (fakta ze snímků):** snímek 3 padne na všech profilech do úvodu souboje (hodiny hry 0,2–1,4 s, `DUEL.lead` = 1,5 s) – soupeř ještě neútočí a povel nesvítí. Snímek 4 je prohra za 4,8 s: skript ťuká doprostřed (= Strike) a nikdy neuhne. Hydra je malý model ještěrky s obrysem („tiny red blob“, „small red lizard, not obviously a three-headed hydra“).
- **Desktop „Tap to start“ v 10 s není chyba:** ruční pokus – po prohře se běh vrátí na start a mezerník ho znovu spustí (snímek 15: srdce 2, 3,0 s, „Dodge!“ nad hydrou). Snímek trefí chvíli mezi návratem a dalším stiskem; stejný snímek je i v měření „Po T6“.
- **Časy:** p50 v klidu (CPU 38–53 %, 5 běhů, `bb5dc7cf`): Pixel 7 **1,51 s**, iPhone 0,88 s, desktop 1,69 s. Prokládané A/B starý build T6 `ce6cc9b7` × nový `bb5dc7cf`, 2 kola po 3 bězích (CPU 33–81 %): Pixel 7 1,74 × 1,58 s, iPhone 0,97 × 0,93 s, desktop 1,75 × 1,68 s; rozptyl obou 0,4–2,9 s. **Inference:** rozdíl je v šumu, opravy T6b start nezpomalily; mez Pixel 7 1,5 s leží uprostřed rozptylu jednoho buildu.
- **Inference – co zbývá a čí to je:** (1) velikost a jmenovka soupeře – P58A má `size hero and foe so a judge can read them` a `name the hero and foe the first time they appear`, sloučení s touto větví dnes konfliktuje v `ArcadePlay.tsx` a `ArcadeStage.tsx`; (2) film měří úvod souboje a prohru skriptu, který neuhýbá – povel uprostřed boje ve snímcích skoro není. Brána „≤ 1 soudce na profil“ je při 3 soudcích a 4 snímcích pod šumem měření (desktop 1 ↔ 3 beze změny kódu).
- E2e `interface-language` + `p35-perf` 20/20 nad `next start` (`bb5dc7cf`).

## Po sloučení P58A (24. 10., build `670c7357`, `first-impression-p58a.json`, listy `first-impression-p58a/*.jpg`)

Sloučení `c9fb5f62` přineslo z P58A větší hrdinu a soupeře a jmenovky („Knight“, „Three-headed hydra“). Oprava `670c7357`: jmenovka hrdiny stála na telefonu nad středem rámečku rytíře i s mečem namířeným na hydru, tedy přímo pod povelem „Dodge!“ / „Strike!“ (e2e po ticích: Pixel 7 tik 192, iPhone tik 183). Teď visí nad kořenem těla; e2e `duel: the name tags never cover the Dodge!/Strike! cue` na obou telefonech zelený, na starém buildu červený.

| | T6b měření 1 | T6b měření 2 | Po sloučení P58A |
|---|---|---|---|
| Rozumím do 2 s – Pixel 7 / iPhone / desktop | 3/3 · 3/3 · 3/3 | 3/3 · 3/3 · 3/3 | **3/3 · 3/3 · 3/3** |
| Ovládání nejasné (soudci na profil) | 3 · 3 · 1 | 3 · 1 · 3 | 3 · 3 · 3 (brána ≤ 1 **nesplněná**) |
| Ztráta „ovládání“ celkem | 15 s | 15 s | 20 s |
| p50 „Make it!“ → vstup – Pixel 7 / iPhone / desktop | 2,5 · 2,8 · 2,4 s | 1,8 · 0,8 · 2,0 s | **1,0 · 1,4 · 2,2 s** (CPU 56 % na startu) |

- **Strojová brána splněná** (`gateMet: true`): časy pod mezemi na všech profilech, rozumím 3/3.
- **Co soudci vidí (fakta ze snímků):** snímek 3 je zase úvod souboje (hodiny 1,3 s, řádek „Beat the three-headed hydras!“, povel ani jmenovka ještě nevisí), snímek 4 prohra skriptu za 4,8 s. Stížnosti na ovládání míří na úvod („wind-up and opening are not visually obvious“) a na nápovědu až po prohře – tedy na chvíle, kdy povel nad soupeřem ze zásady nesvítí.
- **Inference:** zbytek `unclear-controls` je šum měření a tvar filmu, ne chybějící oprava – desktop skočil 1 → 3 beze změny kódu už mezi měřeními T6b a film chytá jen úvod souboje a prohru skriptu, který neuhýbá. Podle rozhodnutí majitele 24. 10. se T6b uzavírá bez dalších oprav.
