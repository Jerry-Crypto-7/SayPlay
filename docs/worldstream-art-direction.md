# Výtvarný směr Worldstreamu – rozhodnutí brány K0

**Rozhodnuto:** 28. 8. 2026, uživatelem, nad `docs/contact-sheet.png` (12 světů) proti
`docs/target-frame.png`.
**Plán:** `plans/P14-2026-08-28-vizualni-vrstva.md`, úloha `HALT: H1`.

---

## Verdikt

**Kontaktní list v dnešní podobě neobstál.** Osm z dvanácti světů projde všemi pěti
prahy obrazového soudce (`src/worldstream/image-judge.ts`), ale prahy měří podlahu –
„není to plochý ani mrtvý obraz". Neměří, jestli to je *místo, kam chceš vejít*, a
právě to je rozdíl proti cílovému snímku.

**Co se s tím dělá:** pustí se **T8** (rámování kamery počítané ze scény), kontaktní
list se přerenderuje a brána se soudí znovu nad opraveným listem. Teprve pak jdou
T9–T11.

**Tohle je vědomá odchylka od bodu „když list neobstojí, fáze 3 se nespouští".**
T8 *je* iterace kompozice, kterou ten bod žádá – jen shodou okolností stojí jako
první úloha fáze 3. Zbytek fáze 3 čeká na druhé kolo brány.

---

## Co konkrétně dělá dojem na cílovém snímku

Tohle je ta část rozhodnutí, která musí jít reprodukovat generovaným světem. Pět
vlastností, seřazených podle toho, kolik dojmu nesou:

1. **Obzor ve třetině výšky.** Hladina protíná snímek zhruba v 38 % výšky, takže nad
   ní je obloha a pod ní země. Oko dostane měřítko zadarmo. **Žádný generovaný svět
   obzor nemá vůbec** – kamera míří dolů do podlahy.
2. **Jedno svítící ohnisko.** Zlatý prstenec na věži plus rozsvícená okna. Je to
   jediné teplé místo v chladném snímku, takže oko nemá kam jinam jít. **V žádném
   generovaném světě nesvítí nic** – emise se v kulise nepoužívá.
3. **Noc a jeden teplotní kontrast.** Teplá (oheň, okna, písek) proti chladné
   (voda, obloha, skála). Generované světy jsou plošné poledne, kde má všechno
   podobný jas – přesně to měří `luminanceSpread`, jenže práh 0,6 propustí i tohle.
4. **Tři vrstvy hloubky.** Tráva a kameny vpředu, budova s mostem uprostřed, útesy a
   obloha vzadu. Generované světy mají **jedno pásmo vzdálenosti** – prstenec kulisy
   ve stejné vzdálenosti dokola.
5. **Cesta, která vede oko.** Most míří zleva zdola k věži. Generované světy mají
   mřížkovou podlahu, což je opak – rovnoměrná plocha bez směru.

## Co je na dnešním listu špatně

**Šest světů z vět čte jako jeden svět šestkrát.** Všech šest projde všemi prahy a
jejich otisky se od sebe měřitelně liší, ale na listu jsou k nerozeznání: stejný
tmavý mřížkový podklad, stejný prstenec skal, beden a stromů po okrajích, stejné
rámování. Liší se jen drobnosti uvnitř prstence. To je vizuální potvrzení
routovaného nálezu **T7-sameness**, který soudce chytit nemůže – „jiný než ostatní"
je vlastnost dvojice, ne snímku.

**Ruční layouty mají opačnou vadu.** Drobný objekt uprostřed vinětované prázdnoty,
bez země pod ním. Čtou se jako model na pozadí, ne jako místo.

## Nejhorší svět a co s ním

**`dunes-terrace`** (políčko 10). Naměřeno: **86,8 % mrtvé plochy**, **jediný
odstín**, rozptyl jasu 0,40 proti prahu 0,6, obloha zabírá **94,9 %** snímku.
Propadá na třech prazích z pěti a je nejhorší i podle dvou z pěti sloupců „worst" v
`docs/contact-sheet.json`.

**Diagnóza:** není to vada palety ani atmosféry. Kamera sedí na `[7, 7, 9]` a míří
do počátku, tedy 31,5° pod vodorovnou při svislém poloúhlu 22,5°. Kde podlaha kitu
sahá, zakryje pozadí beze zbytku (`harbor-pier`, obloha 0 %); kde podlaha dojde,
zbude prázdná koule pozadí (`dunes-terrace`, obloha 94,9 %). Je to táž jediná
příčina v obou extrémech.

**Co s ním:** opravuje ho **T8**, ne nová paleta. Až se rámování počítá z naměřeného
obalu scény, `dunes-terrace` musí spadnout do pásma oblohy 15–45 % a mrtvá plocha
pod 0,55. Jestli po T8 nespadne, je to vada layoutu samotného a layout se přepíše
nebo vyřadí.

## Podmínky druhého kola brány

Nad přerenderovaným `docs/contact-sheet.png` po T8 se soudí tohle – ostatní úlohy
fáze 3 čekají:

- **Obzor je vidět** a obloha zabírá 15–45 % plochy u **všech dvanácti** světů.
- **Žádný svět nepropadá na mrtvé ploše** – `DEAD_WORLDS_UNTIL_FRAMING` v
  `e2e/worldstream-atmosphere.spec.ts` klesne z 1 na 0 a zapíše se proč.
- **Šest světů z vět už nečte jako jeden.** Když je rámování počítané ze scény a
  scény se liší, měly by se lišit i záběry. Když ne, je vada v kulise (jeden a týž
  prstenec dokola), ne v kameře, a to je nová úloha.

## Co tohle rozhodnutí NEmění

Odvození vzhledu (`src/worldstream/look.ts`), pět vlastností soudce a jejich prahy,
odemčené kusy kitu ani figury v rodinách. Všechno z fáze 1 a 2 zůstává, jak je –
brána nenašla vadu v ničem z toho. Vada je v tom, **kam se kamera dívá**.
