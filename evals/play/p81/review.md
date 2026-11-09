# P81 T7 – listy před/po a nezávislé posouzení

Snímky `evals/play/p81/after/` (72: 12 her × desktop/telefon × start, 3 s, 8 s; finální build `219ffb70`), základ `evals/play/p81/base/` (`main` před P81), listy `evals/play/p81/sheets/` (12, dnes | P81), čísla `evals/play/p81/after.md` (`p81-diff.mjs`).

## Čísla (finální build)

- Medián změny desktop 3 s **26,7 %** (nejmenší s6 8,6 %), medián všech 72 snímků 26,5 %.
- Největší posun odstínu středu 9° (s11) – brána ≤ 15° drží u všech 12 her.
- Fialová (odstín 250–320°): nejvíc 0,17 % snímku (s11, modrofialové květy modelu `gen3d-wildflower-patch`, viz R3); před P81 až 2,15 % (obloha s12).

| Hra | změna desktop 3 s | změna telefon 3 s | odstín středu 3 s (před → po, posun) |
|---|---|---|---|
| s1 sopka | 28,2 % | 36,2 % | 23° → 24°, 1° |
| s2 pod vodou | 12,1 % | 13,0 % | 39° → 41°, 2° |
| s3 střechy | 40,2 % | 70,6 % | 31° → 28°, 3° |
| s4 hrad (palačinky) | 32,9 % | 47,8 % | 30° → 29°, 1° |
| s5 létající ostrovy | 20,6 % | 39,9 % | 46° → 51°, 5° |
| s6 vesmír | 8,6 % | 6,5 % | 14° → 14°, 1° |
| s7 minigolf | 27,1 % | 21,7 % | 112° → 106°, 6° |
| s8 hrad (koruna) | 26,4 % | 44,0 % | 32° → 32°, 0° |
| s9 bouřka ve městě | 41,0 % | 68,5 % | 154° → 147°, 7° |
| s10 sad | 23,6 % | 15,3 % | 120° → 115°, 5° |
| s11 cukrová země | 44,0 % | 58,2 % | 32° → 22°, 9° |
| s12 sníh | 16,9 % | 33,8 % | 236° → 230°, 6° |

## Nezávislý soudce – 1. kolo (čerstvý subagent, jen cesty dnes | P81 | předloha `p75/target/sN.png`, desktop 3 s) – doslova

Build `05b85dce`. Změna desktop 3 s u her z opravného kola tehdy: s6 2,6 %, s7 13,8 %, s10 22,0 %, s11 39,8 %.

```
s1: blíž: ano – víc teplého oparu v dálce a dlouhé stíny stromů přes cestu, víc jako slunečný opar předlohy; čitelnost: stejná – hrdina a kámen vpředu jsou stejné, jen tmavá překážka v dálce trochu mizí v mlze.
s2: blíž: stejně – pořád chladná tyrkysová scéna, předloha je teplý západ slunce; přibyly jen tmavé obrysy u rostlin po stranách; čitelnost: stejná – želva, žraloci i šipky vypadají skoro stejně.
s3: blíž: ne – z podlahy zmizely dlaždice, které má střecha v předloze, zbyla jednolitá hnědá plocha; čitelnost: lepší – kočka, prkno i drobnosti na klidné podlaze vystupují víc a mají obrys a delší stín.
s4: blíž: ne – dlažba zmizela a zem je kalně šedohnědá, předloha je světlá zelená a teplá; čitelnost: lepší – palačinky, rytíř a předměty mají černý obrys a na jednolité zemi se lépe oddělují.
s5: blíž: ano – voda je sytě modrá a ostrůvky mají nahoře nádech do zelena, blíž předloze; čitelnost: lepší – vajíčko (cíl) je větší a obtažené, palmy a rytíř mají obrysy.
s6: blíž: stejně – obloha, rudá zem i barvy zůstaly, přibyly jen tenké obrysy u krystalů a skal; čitelnost: stejná – rozdíl je jen v obrysech krystalů, raketa i cíle jsou stejné.
s7: blíž: stejně – tráva zůstala tmavě sytě zelená bez teplého světla předlohy, jen stíny květin se trochu prodloužily; čitelnost: stejná – míček, jamka i okraj dráhy vypadají stejně.
s8: blíž: ne – kamennou dlažbu nádvoří, kterou předloha má, nahradila šedohnědá jednolitá plocha; čitelnost: stejná – bedny a koruna mají obrys, ale přes zem vpředu se táhnou velké tmavé pruhy stínů.
s9: blíž: ano – zem už není skoro černá, ale světlejší modrozelená, scéna je méně ponurá (teplé světlo předlohy pořád chybí); čitelnost: lepší – hrdina, kašna i budovy mají obrysy a z tmavé země vystupují mnohem víc.
s10: blíž: stejně – stromy zůstaly sytě tmavě zelené, předloha je pastelová a slunečná; přibyly jen obrysy korun; čitelnost: stejná – hrdina, obruč i koš vypadají stejně, obrysy jen oddělují koruny stromů.
s11: blíž: ano – červenobílé obrubníky jako v předloze, teplejší oranžová cesta, dlouhé stíny a opar v dálce; čitelnost: lepší – okraje cesty jsou výrazné a šipky zrychlení syté a jasně viditelné.
s12: blíž: ano – přes svah přibyly dlouhé modravé stíny jako v předloze, barvy ale zůstaly šedé bez zlatého nebe; čitelnost: lepší – vločka, tučňák i překážka mají obrys a jsou zřetelnější, jen konec trati víc mizí v mlze.
```

Výsledek 1. kola: blíž **5× ano / 3× ne / 4× stejně**, čitelnost **6× lepší / 6× stejná / 0× horší**.

## Opravné kolo (jedno) – `219ffb70`

Cíl: čtyři hry „stejně“ (s2, s6, s7, s10).

- **Tráva za slunce (s7, s10, i s11):** zem s trávou (louka, les, džungle) o 24° ke žluté v barvě, sytost −0,25, světlost +0,1, pak předem ochlazená jako ostatní podlahy – osvětlená se posune nejvýš o 15° (pin), pořád tmavší než rajčatová o víc než 15 % jasu (pin, červená–zelená slepota). Dřív profil trávu jen sytil a pod nízkým sluncem ztmavla.
- **Vesmír (s6):** dostane teplé nízké slunce profilu (dlouhé stíny, teplejší světlo); černé hvězdné nebe si nechá. Dřív byl celý vyjmutý jako „noční rodina“.
- **Pod vodou (s2) beze změny:** teplé slunce by osvětlené dno posunulo o 93° (brána 15°); předloha s2 je západ slunce nad mělčinou, ne podmoří – rozhodnutí o paletě patří majiteli.

## Nezávislý soudce – opravné kolo (nový čerstvý subagent, stejný brief, s6, s7, s10, s11) – doslova

```
s6: blíž: stejně – jediný rozdíl jsou delší a ostřejší stíny od nízkého slunce, ale země zůstala rezavě rudá a obloha mlhovina, nikde zlatavě písková plošina s planetami jako v předloze; čitelnost: stejná – raketa, krystal i červeně orámované cíle vypadají skoro stejně a delší stíny jen trochu přidaly hloubku.
s7: blíž: ano – tráva mimo dráhu je světlejší a žlutozelenější a květiny vrhají dlouhé stíny, což se trochu blíží teplému světlu předlohy, ale dráha zůstala tmavě zelená a nejsou tu pastelové barvy; čitelnost: stejná – míček, jamka i mantinely vypadají stejně a jen o kousek světlejší okolí dráhu nepatrně odliší.
s10: blíž: ano – pozadí je teplejší a mlhavější a země o něco světlejší, takže se scéna blíží teplému zlatavému světlu předlohy, i když koruny stromů zůstaly sytě zelené místo pastelových; čitelnost: lepší – tmavé obrysy oddělují koruny stromů od sebe i od trávy a košík s postavou na nich vystupují zřetelněji.
s11: blíž: ano – přibyly červenobílé obrubníky jako v předloze, cesta je teplejší oranžovohnědá, pozadí v teplém oparu a stíny dlouhé; čitelnost: lepší – obrubníky jasně vymezují trať a posilovací šipky se čtou jako šipky, jen oranžový hrdina na oranžovější cestě trochu splývá a drží ho hlavně černý obrys.
```

## Výsledek (poslední verdikt u každé hry)

- Blíž předloze: **7× ano** (s1, s5, s7, s9, s10, s11, s12), **3× ne** (s3, s4, s8), **2× stejně** (s2, s6).
- Čitelnost cíle, překážek a hrdiny: **7× lepší**, **5× stejná**, **0× horší**.

## Co zůstává (poctivě)

- **s3 a s8 „ne“ kvůli dlažbě:** předlohy střechy a hradního nádvoří mají dlaždice; T4 je mimo interiéry podle směru majitele zrušil („oblý terén bez dlaždic a spár“). Vrátit dlažbu jen těmto místům je rozhodnutí majitele.
- **s4 „ne“:** soudce chce zelenou zem předlohy; R2 vrátil hradu kámen (zelená vyšla neonová). Beze změny.
- **s6 „stejně“:** předloha má světlou pískovou plošinu, hra rezavou zem Marsu; posun zemi do žluté by přetáhl bránu odstínu (střed 14°, předloha ~35–40°). Viditelné jsou jen dlouhé stíny.
- **s2 „stejně“:** viz opravné kolo – teplé slunce pod vodou nepustí brána odstínu.
- **s7:** hrací plocha minigolfu má barvu z brand tokenu `colorHex.grass` v `MinigolfScene` (mimo povolené soubory P81), mění se jen okolní tráva.
- **s11:** soudce poznamenal, že oranžový hrdina na teplejší cestě trochu splývá (drží ho obrys) – čitelnost přesto „lepší“.
