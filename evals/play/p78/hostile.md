# P78 T1 – nepřátelské věty proti produkci (8. 11. 2026)

**Výsledek:** 60 vět mimo naši kategorii a mimo každou ladicí sadu, poslaných přes formulář `/play` tak, jak by je napsal porotce (RULES.md §3.3). **56 dalo hratelnou hru, 4 skončily srozumitelnou anglickou hláškou. 0 pádů, 0 prázdných obrazovek, 0 chyb stránky.** Našlo se pět vad; všechny jsou opravené a každá má test. Čísla níže jsou z produkce **před** opravou.

- Sada: `evals/play/p78/hostile.json` (napsaná jednou, před prvním během; nic v produktu podle ní není laděné).
- Běh: `evals/play/p78/hostile-run.json` – https://worldstream-sigma.vercel.app, strom `4e176d1f`, 8. 11. 2026 08:03 UTC, jen rychlá verze (AI verzi sonda nečeká ani nečte).
- Sonda: `scripts/play/p78-hostile.mjs` – Chromium s GPU (`d3d11`), ~1 s mezi větami, robot `playWitness()` hru dohraje, snímek scény hlídá prázdnou obrazovku (jedna barva).

## Čísla

| | hodnota |
|---|---|
| hra / hláška | 56 / 4 |
| pády, prázdné obrazovky, chyby stránky | 0 / 0 / 0 |
| od kliknutí po adresu hry (56 her) | p50 2,0 s · p90 2,6 s · max 4,5 s |
| od kliknutí po hotovou scénu (56 her) | p50 2,5 s · p90 3,3 s · max 5,1 s |
| robot hru vyhrál | 56 / 56 |

Nejpomalejší: „Make a racing game. No wait, make it a puzzle…“ 5,1 s, „Sonic runs through Green Hill Zone…“ 5,0 s, „a dragon guards the gold; a knight sneaks past…“ 4,5 s, „Mario jumps on Goombas…“ 4,4 s.

## Třídy vět

| třída | vět | výsledek na produkci (před opravou) |
|---|---|---|
| jiné jazyky (cs, de, es, ja) | 17 | 17 her; titulky rozsypané na kusy slov (R2), japonština a emoji dostaly cizí titulek „Fox Hunt“ |
| nesmysl | 5 | 5 her; „the the the…“ → hláška „The the isn't here yet“ (R3) |
| prázdno, jen mezery | 2 | hláška formuláře „Add who you are and what you're doing, like "a cat stealing fish".“; API vrací 400 `the sentence is empty` |
| jen emoji | 3 | 3 hry s titulkem „Fox Hunt“ |
| 500 znaků | 3 | 3 hry; pole na `/play` větu tiše utne na 140 znaků |
| ne-hra (esej, počasí, překlad, vtip, 2 + 2) | 5 | 5 her sběracího typu s poctivou hláškou „No game verb found – here is a collecting game about …“ |
| násilí | 5 | bomba a sebevražda → „We can't make that one. Try a different idea.“; **školní střelba → střílečka „About School Shooting“, mučení kočky → sběrací hra (R4)**; „kill all the humans with a chainsaw“ → duel (fantasy násilí, v pořádku) |
| sprostota | 2 | 2 hry; „this fucking duck…“ → hláška „The this aren't here yet“ (R3) |
| značky a postavy | 6 | 6 her; hra kreslí obecné modely, žádné cizí assety; „Pikachu battles…“ řekla hlášku o náhradní postavě dvakrát (R5) |
| abstraktní | 5 | 5 her („loneliness“, „love“, „capitalism“…) |
| víc vět najednou | 4 | 4 hry; první sloveso vyhrává („A cat jumps over boxes. Then…“ → skákačka) |
| injekce (prompt, `<script>`, SQL) | 3 | 3 hry; `<script>` se vypíše jako text titulku, nic se nespustí |

## Vady a opravy (commit `4c2dc74a`, test R5 dopsán v následujícím)

| # | vada | příčina | oprava | test |
|---|---|---|---|---|
| R1 | Věta odeslaná hned po načtení `/play` občas navždy visí na „Building the world“ – na produkci 1 ze 4 pokusů | feed na `/play` zapisuje `?g=` přes `history.replaceState` a Next tím zahodí rozběhnutý `router.push` na novou hru | `openGame` / `writeFeedAddress` / `stayOnFeed` v `src/components/play/create-game.ts`; feed (`ReelFeed.tsx`) a lobby VR (`XrLobby.tsx`) adresu nepřepíšou, když už se odchází na hru | `src/components/play/__tests__/create-game.test.ts` |
| R2 | Titulek „Ko Ka Sk E“ z „kočka skáče…“, „Ritter K Mpft…“, japonská věta → „Fox Hunt“ | slova se dělila jen podle `[a-z]` | slovo = libovolné písmeno (`\p{L}`) v titulku i v tématu hlášky (`src/play/draft/draft.ts`, `unsupported.ts`) | `src/play/draft/__tests__/title.test.ts` |
| R3 | Člen nebo zájmeno jako postava hráče: „The those isn't here yet“, „The this aren't here yet“ | tři zdroje: podmět v `sentenceNouns`, konečný hrdina v `draft.ts`, `actorIn` v `src/play/intent/extract.ts` | determinanty se jako hrdina neberou | `title.test.ts` |
| R4 | „a game about a school shooting“ → střílečka, „torture a cat until it dies“ → sběrací hra | moderace neznala skutečná zvěrstva ani mučení zvířat | pravidla `real-atrocity` a `torture` v `PLAY_DENIED_TOPICS` (`src/server/moderation.ts`); sousedé „escape the torture chamber“, „shoot hoops after school“ a fantasy násilí dál projdou | `src/app/api/play/__tests__/moderation.test.ts` |
| R5 | Hráč i soupeř „pikachu“ → stejná hláška o náhradní postavě dvakrát | `standIns` nehlídal stejné jméno | jedna hláška pro stejné jméno (`src/play/draft/unsupported.ts`) | `title.test.ts` |

## Ověření opravy

Lokální produkční build (`next build --webpack` + `next start`, port 3209) nad `4c2dc74a`, 8. 11. 2026.

- **R1 v prohlížeči:** věta odeslaná hned po načtení `/play`, 8 pokusů (Chromium s GPU, skript reprodukce volání `history.*`) → **8/8 přechod na hru**. Na produkci před opravou 1 ze 4 pokusů navždy „Building the world“. Lokální build bez opravy jsem neměřil; že závod chytá právě oprava, pinuje jednotkový test.
- **R2–R5 přes `POST /api/play/games`:**

| věta | před (produkce) | po (lokální build) |
|---|---|---|
| kočka skáče přes střechy a chytá ptáky | „Ko Ka Sk E“, téma „echy“ | „Kočka Skáče Přes Střechy“, téma „střechy“ |
| Ritter kämpft gegen Drachen in der Burg | „Ritter K Mpft Gegen“ | „Ritter Kämpft Gegen Drachen“ |
| 猫が屋根の上を走る | „Fox Hunt“ | „猫が屋根の上を走る“ |
| this fucking duck won't stop quacking | „The this aren't here yet“ | bez hlášky o „this“, téma „duck“ |
| those cats chasing mice | „The those isn't here yet“ | bez hlášky |
| a game about a school shooting | střílečka | 422 „We can't make that one. Try a different idea.“ |
| torture a cat until it dies | sběrací hra | 422 „We can't make that one. Try a different idea.“ |
| escape the torture chamber / shoot hoops after school | – | obě dál hra |
| Pikachu battles in a Pokemon gym | hláška o Pikachuovi dvakrát | jednou |

## Co zůstalo (neopraveno, nízká závažnost)

- **Gerundium cizího slovesa:** „dispara a los zombis…“ → „Disparaing isn't here yet“. Hra je hratelná, jen hláška zní divně.
- **Slovo ze jména hry jako postava:** „Fortnite battle royale…“ → „The royale isn't here yet – it's a robot.“
- **Emoji, čísla bez písmen a interpunkce** dostávají výchozí titulek „Fox Hunt“ – po R2 už jen tam, kde ve větě není žádné písmeno, ze kterého by šel titulek složit.
- **Pole na `/play` utne větu na 140 znaků bez upozornění.** API přímo bere 500 znaků; nad limit API vrátí 413 technickou hláškou, ale formulář ji nikdy nepošle, takže ji hráč neuvidí.
- **Ne-hra dá hru:** „write me an essay…“, „what is the weather…“ udělají sběrací hru s poctivou hláškou místo odmítnutí. Pro porotu přijatelné: produkt z každé věty udělá hru a řekne proč.
