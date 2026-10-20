# P52 – konečné měření na holdoutu

**Krátce:**
- **Na nové nezávislé sadě cíl nesplněn.** Holdout P52 (40 vět, otevřený jednou 19. 10. 2026 na `2d3e69c4`): hrdina má akci z věty **0,13** (cíl ≥ 0,85), robot ji použije **0,23**, sloveso se ve hře projeví **0,23**, past „sloveso nepřítele dá akci hrdinovi“ **0,2** (cíl ≤ 0,1). Hratelné 40/40, p95 návrhu 1,73 s.
- **Na sadách, na kterých se ladilo, cíl splněn:** P52 dev 0,94 / 0,97 / 0,97, P47B dev 0,96 / 0,96 / 0,94, P46A 1 / 1 / 0,95, past 0.
- **Příčina (fakt z měřidla):** všech 29 vypadlých akcí má důvod „slovník sloveso nezná“. Holdout říká tytéž akce jinými slovy („bonks“, „nabs“, „juking past“, „fends off“, „torpedoes“). Mechaniky ve hře jsou, chybí jejich poznání ve větě.
- **Závěr (inference):** seznam slov psaný podle dev sady nezobecňuje. Na „největší otázku“ plánu je odpověď ne: cíl 0,85 bez přestavby čtení sloves dosažitelný není – patří do přestavby po 11. 11.
- **Párový soud B proti A nesplněn:** podíl B **0,525** (cíl ≥ 0,6) – B 4, A 2, remízy 34 ze 40.

## Cíle na holdoutu

| Metrika | Cíl | Holdout P52 | 95% interval (Wilson) | Splněno |
|---|---|---|---|---|
| hrdina má akci z věty (`hasAction`) | ≥ 0,85 | 0,13 (4/30) | 0,05–0,30 | ne |
| robot akci použije (`botUsed`) | ≥ 0,85 | 0,23 (7/30) | 0,12–0,41 | ne |
| sloveso se ve hře projeví (`verbFired`) | ≥ 0,85 | 0,23 (7/30) | 0,12–0,41 | ne |
| past nepřítele (`spuriousRate`) | ≤ 0,1 | 0,2 (2/10) | 0,06–0,51 | ne |
| hratelné | 100 % | 40/40 | – | ano |
| p95 návrhu | ≤ 2 s | 1,73 s | – | ano* |

\* Měřeno při 80–100 % CPU od testů jiného projektu na stroji. Dev sady ve stejné zátěži 2,6–3,6 s; v klidu stroje neměřeno.

## Vedle: sady, na kterých se ladilo, a srovnání s P47B

| Sada | hasAction | botUsed | verbFired | past |
|---|---|---|---|---|
| P52 dev (40) – po T1 | 0,12 | 0,24 | 0,24 | 0,5 |
| P52 dev (40) – teď | 0,94 | 0,97 | 0,97 | 0 |
| P47B dev (65) – konec P47B | 0,74 | 0,84 | 0,82 | 0 |
| P47B dev (65) – teď | 0,96 | 0,96 | 0,94 | 0 |
| P46A (20) – konec P47B | 1 | 1 | 0,89 | – |
| P46A (20) – teď | 1 | 1 | 0,95 | – |
| holdout P47B (27) – konec P47B | 0,65 | 0,70 | 0,70 | 0,14 |
| **holdout P52 (40) – teď** | **0,13** | **0,23** | **0,23** | **0,2** |

Rozdíl dev 0,94–0,97 proti holdoutu 0,13–0,23 je přeučení na slova, ne na mechaniky (inference): kde se aspoň jedna chtěná akce z věty do hry dostala, robot ji použil v 7 z 8 vět (výjimka h06 – duel, úder ve hře je, robot ho nepoužil).

## Co zbylo – slovesa, která slovník nezná

Fakt z měřidla (holdout je otevřený, nic se podle toho neladí):

- **dash (8):** „cartwheeling away“, „darts sideways past“, „bolts past“, „juking past“, „diving out of the way“, „sprinting past“, „boosting past“, „hopping aside“.
- **grab (7):** „pockets“, „snagging“, „pinching“, „nets“, „yanking“, „scooping up“, „looting“.
- **shoot (5):** „lobs fireballs at“, „flings shurikens at“, „pelting … with“, „torpedoes“, „hurling pumpkins at“.
- **shield (5):** „putting up a force field“, „raise an ice wall“, „bouncing cannonballs back“, „fends off“, „warding off“.
- **strike (4):** „bonks“, „uppercutting“, „body-slamming“, „clobbering“.
- **Past (2):** „the cat keeps trying to grab it“ dá hrdinovi krádež (h11), „eagles keep swooping down to peck at you“ úder (h32) – sloveso nepřítele s podmětem „it“ / „you“ až za vedlejší větou.

„looting“ a „putting up a force field“ seznam zná, a přesto vypadly; důvod měřidla je hrubý („slovník nezná“ = akce se z věty nedostala). Neověřeno, kde se ztratily.

Podle žánru vypadlo nejvíc v aréně se sběrem (9 vět, akce 0/9) a u žánrů, kam P52 akce vůbec nedal (hod, klouzání, míč, skákačka – 9 vět, 0/9).

## Párový soud

Slepý párový soud P45A (Codex nad listem dvou klipů, list jako `sheet.png` v prázdné dočasné složce) nad celým panelem P45 (40 buněk), A = `origin/main` `5d741740` (P51 sloučený), B = větev `2d3e69c4`, oba servery jen rychlá verze bez klíče modelu, souběh 1, semínko 45045, 40 volání Codexu bez chyby:

| | B | A | Remíza | Podíl B | Cíl |
|---|---|---|---|---|---|
| panel P45 | 4 | 2 | 34 | **0,525** | ≥ 0,6 – ne |

- B vyhrál `f01`, `f10`, `h03`, `m01`; A vyhrál `d03`, `s002`.
- **Proč tolik remíz (inference):** A i B mají P51, liší se jen P52, a P52 mění jen hry, kde věta říká akci hrdiny. Většina vět panelu P45 žádné takové sloveso nemá, takže obě strany postaví stejnou hru – soud na panelu P45 změnu P52 skoro nevidí. Podíl 0,525 proto neříká „B je horší“, ale „na tomhle panelu skoro stejné“.
- Zábava B nad panelem (telemetrie P45A): hratelné 40/40, mrtvý čas medián 2,5 s (≤ 3), stoupání 1 (≥ 0,7), chování medián 2 (≥ 2), finále 0,93 (≥ 0,8) – vše splněno.

Data: `final.json` (`pairwise`, `fun`), surové výroky `evals/play/fidelity/runs/p52-t11-pairwise.json` (gitignorované).

## Doporučení

1. **Čtení sloves přestavět, ne rozšiřovat seznam.** Dalších 30 slov by holdout P52 zvedlo, ale na další nezávislé sadě by se to opakovalo. Akci z věty ať určí model nad celou větou (P53 režisér už větu čte) s uzavřenou množinou pěti akcí a ověřením robotem jako teď – slovník zůstane jako rychlá cesta bez sítě.
2. **Past nepřítele řešit stejným čtením:** kdo sloveso dělá, rozhodne čtení věty, ne vzor kolem slova.
3. **Akce v žánrech, které je nemají** (hod, klouzání, míč se střelou, skákačka) až po bodu 1 – bez čtení sloves by se neprojevily.
4. **Párový soud akcí měřit na větách s akcí** (třeba holdout P52), ne na panelu P45 – tam 34 ze 40 dvojic vyšlo nerozhodně, protože se hry neliší.
5. **Pro porotu (do odevzdání):** spolehlivé jsou věty s běžnými slovesy (dash, dodge, shield, block, shoot, fire at, grab, steal, punch, kick). Demo věty držet v tomto slovníku.
