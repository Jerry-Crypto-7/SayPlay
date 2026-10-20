# P54C – závěrečné měření na zapečetěném holdoutu (T16)

**Co to znamená:** všech osm nových žánrů hraje a robot každou hru vyhraje. Hráč ale svůj žánr dostane jen u 62 % vět, které ho jasně popisují (cíl 80 %). Čtyři žánry fáze 3 cíl splnily (82 %), čtyři žánry MVP ne (44 %). Klasifikátor (čtení věty podle klíčových slov) se naučil slovník dev sady a věty psané jinými slovy pouští do starých her.

## Jak se měřilo

- **Holdout:** 80 vět, které 19. 10. napsal nezávislý autor bez přístupu ke kódu (60 cílových – 8 na každý žánr MVP, 7 na každý žánr fáze 3 – a 20 rušivých). Otisk SHA-256 `c3d545c5…` sedí na zapečetění z T2. Otevřený jednou (`holdout-opened.json`), nic se podle něj neladí.
- **Cesta:** produkce bez modelu – klasifikátor a rychlý návrh hry (semínko 1, Rapier načtený), pak robot světa (`verifyArcade`) nad hrou, kterou návrh vrátil. Commit měření v `final.json`.
- Věta h03 není nezávislá (autor ji dostal jako příklad, viz README „Sady“); počítá se, minula.

## Brány

| Brána | Výsledek | Cíl | |
|---|---|---|---|
| Cílová věta hraje svůj žánr | **37/60 = 0,62** | ≥ 0,8 | ❌ |
| Rušivá věta nehraje nový žánr | 20/20 = 1,00 | ≥ 0,85 | ✅ |
| Hratelné (robot vyhraje) | 80/80 = 1,00 | 1,00 | ✅ |
| Výhra robota za 30–90 s | 76/80 = 0,95 (cílové 59/60) | ≥ 0,9 | ✅ |

Navíc: nečinný hráč prohraje 80/80, přehrání záznamu sedí 80/80. Klasifikátor a návrh se shodují u každé věty – každé minutí vzniká už při čtení věty, ne při skládání hry.

## Po žánrech

| Žánr | Fáze | Správný žánr | Robot vyhraje | 30–90 s | Co hrály minuté věty |
|---|---|---|---|---|---|
| Chytání (`catch`) | MVP | **2/8** | 8/8 | 8/8 | aréna útěk 3, aréna sběr 2, běžec 1 |
| Bouchání (`whack`) | MVP | 4/8 | 8/8 | 8/8 | úkol 3, aréna útěk 1 |
| Obrana pruhů (`defense`) | MVP | **3/8** | 8/8 | 8/8 | aréna sběr 2, běžec 2, střílečka 1 |
| Krájení (`slice`) | MVP | 5/8 | 8/8 | 8/8 | hod 1, skákačka 1, úkol 1 |
| Přeskákání silnice (`hop`) | po odevzdání | 6/7 | 7/7 | 7/7 | skákačka 1 |
| Dav a brány (`crowd`) | po odevzdání | 4/7 | 7/7 | 6/7 | aréna sběr 1, plavba 1, běžec 1 |
| Pouštění a slučování (`merge`) | po odevzdání | **7/7** | 7/7 | 7/7 | – |
| Vytlačování z ringu (`push`) | po odevzdání | 6/7 | 7/7 | 7/7 | plavba 1 |
| **MVP celkem** | | **14/32 = 0,44** | 32/32 | 32/32 | |
| **Po odevzdání celkem** | | **23/28 = 0,82** | 28/28 | 27/28 | |

Výhra mimo 30–90 s u 4 her: h55 aréna 21,7 s, h58 hod 27,1 s, h65 plavba 28,1 s (cílová věta davu, která hrála plavbu), h80 hod 13,8 s – staré žánry, kam věty padly.

## Proč žánry MVP minuly

**Fakt:** minuté cílové věty popisují žánr jasně, jen jinými slovy než dev sada. Chytání: „collect falling stars in a basket“, „grabs presents dropping from the sleigh“, „slide my bowl under it“. Bouchání: „pop up … hit them“, „smash them quick“, „tap them before they vanish“. Obrana: „march down three lanes … place archers“, „rush my village gate in waves“. Krájení: „swipe through gems … split them“. Dav: „x2 gates“, „doubling hoops“.

**Úsudek:** dev sada (T2) psaná stejným autorem jako klasifikátor nesla slova, na která se klasifikátor naladil (dev 8/8 u každého žánru, T13). Na nezávislých větách je to vidět jako přeučení na slovník. Proč fáze 3 dopadla líp, neověřuji – zasažené věty jsem nečetl, četl jsem jen minuté.

## Co je hotové

- **MVP (do 11. 11. 2026):** Chytání, Bouchání, Obrana pruhů, Krájení – živé, robot 20/20, novice 0,45–0,55, intermediate 1,00, e2e na telefonu, režisér je nabízí (T5–T8, T13, T14).
- **Po odevzdání:** Přeskákání silnice, Dav a brány, Pouštění a slučování, Vytlačování z ringu – živé se stejnými branami, klasifikátor i režisér (T9–T12, T13b, T14b).

## Doporučení

1. **Rozšířit slova žánrů MVP na nové dev sadě od jiného autora** (ne z tohohle holdoutu – ten je teď spotřebovaný a dál platí jako dev data). Cílit na slovesa a obraty výš: padající věci do nádoby, „pop up“ / „smash“, vlny po pruzích, „swipe / split“.
2. **Nový zapečetěný holdout** pro další měření – tenhle už nezávislé číslo nedá.
3. Do té doby žánry MVP dostanou jen věty se slovy dev sady nebo volbu režiséra (režisér je volí správně u 32/32 dev vět, T14) – pro demo je bezpečnější cesta přes režiséra.
