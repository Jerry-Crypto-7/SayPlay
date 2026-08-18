# Doktrína přenosu — co si tenhle projekt nese z návrhové práce jinde

> **Clean-room výtah.** Vznikl přečtením reuse zprávy a patnácti rozhodovacích
> záznamů (ADR) z jednoho staršího návrhového repozitáře. Přenáší se **úvahy,
> kompromisy a poučení**. Nepřenáší se **jediné jméno**: žádný název služby,
> třídy, tabulky, endpointu, balíku, repozitáře ani produktu. Mechanismy jsou
> popsané obecnými slovy, protože tenhle repozitář je veřejný.
>
> Poučení, které by nešlo napsat bez vlastnického jména, se sem nepíše vůbec.
> Nakonec takové nebylo ani jedno — všech patnáct rozhodnutí šlo popsat
> mechanismem. Jediná skutečná mezera je opačná a je pojmenovaná v sekci
> „ECA doktrína".

## Jak tenhle dokument číst

Každý záznam níž má dvě části: **co se rozhodlo** (fakt z pramene) a **co si
z toho bereme** (přenositelné poučení). To druhé je odvození, ne citace.

Kdyby na některý z těchto záznamů odkazoval komentář v kódu, musí ho tenhle
soubor obsahovat — hlídá to `scripts/__tests__/doctrine-links.test.ts`, aby odkaz
nemohl viset do prázdna. Dnes takový komentář v `src/server/` **není ani jeden**;
ten test to měří a vypisuje, místo aby prázdnou množinu vydával za splněnou
kontrolu.

---

## Rozhodnutí a jejich přenositelné poučení

### ADR-0001 — fork příbuzného projektu místo greenfieldu

**Rozhodlo se:** vzít existující klientský projekt s ~60 % lešení hotového. Jiný
kandidát se zamítl, přestože byl technicky bližší — měl špatný *tvar* domény
(symetrická aréna nezná stavění, umisťování ani snímky stavu).

**Bereme si:** reuse se počítá podle tvaru domény, ne podle počtu řádků. A fork
si vždycky nese odstrojovací daň — odpojení platformy, kterou nepoužijeme. Ta daň
patří do odhadu předem, ne do půlky práce.

### ADR-0002 — polyglotní backend s tvrdou hranicí

**Rozhodlo se:** tři runtimy, každý tam, kde už měl ověřený produkční provoz.
Komunikace výhradně přes HTTP a události; žádný sdílený stav, žádná sdílená
databáze.

**Bereme si:** hranice mezi službami se kreslí tam, kde už leží funkční kód.
Tabulka „která starost patří kam" s pravidlem *nikdy dvě starosti v jedné službě*
vyjde levněji než sjednocení stacku.

### ADR-0003 — nástroj řízený modelem je předloha, ne závislost

**Rozhodlo se:** konverzačním modelem řízený nástroj se nesmí volat v produkční
cestě. Jeho orchestrace se přepsala do vlastního deterministického kódu; originál
zůstal jako předloha a jako měřítko kvality.

**Bereme si:** tohle je z celého korpusu nejbližší poučení k tezi tohohle
projektu. Model v horké cestě znamená tři věci naráz — nedeterminismus, cenu za
každý požadavek a nemožnost zátěžového testu. **Model je autor předlohy, ne
runtime.**

### ADR-0004 — jeden vlastník peněžního stavu

**Rozhodlo se:** veškerý zůstatek vlastní jedna služba, ostatní čtou přes HTTP a
zapisují událostí. Dvě různé měny zůstaly ve dvou oddělených účetnictvích
záměrně.

**Bereme si:** jeden vlastník stavu, nikdy přímý zápis do cizí databáze. A dvě
podobné veličiny se neslučují jen proto, že vypadají stejně.

### ADR-0005 — strop se dává na hromádku, ne na zůstatek

**Rozhodlo se:** strop na *čekající* hromádku, ne na utratitelný zůstatek.
Výpočet líně při přihlášení místo globálního tiku. Přebytek nad strop propadá —
to je ta retenční páka. Autoritou je server.

**Bereme si:** ověř existenci předpokládané kódové cesty ve zdrojích dřív, než na
ní postavíš odhad. Jeden odhad tam stál na cestě, která neexistovala.

### ADR-0006 — rozhodnutí se opravuje dalším rozhodnutím

**Rozhodlo se:** revize čtením zdrojáků našla v předchozím záznamu dvě faktické
chyby — cílová služba byla legacy komponenta bez infrastruktury pro události a
hotová cesta „výsledek → odměna" ležela úplně jinde.

**Bereme si:** opravné rozhodnutí je **nový záznam**, ne přepsání starého.
A vypíšou se obě části zvlášť: co padlo i co platí dál. Přepsaný záznam je
ztracená informace o tom, že se někdo spletl.

### ADR-0007 — ohraničený modul místo čtvrté služby

**Rozhodlo se:** po debatě s druhým modelem vznikl ohraničený modul uvnitř
existující služby s dokumentovaným švem pro pozdější vytržení. Výsledek epizody,
okamžitá odměna přítomného a čekající řádek nepřítomného se zapisují **v jedné
transakci**.

**Bereme si:** tři věci. Odmítnutí nevhodné cesty není odmítnutí hostitele — to
je falešné dilema. Integritní zápis se netrhá do distribuované ságy kvůli čistotě
diagramu. A akruál se vede jako **řádky s příznakem**, ne jako časové okno „od
poslední sklizně" — okno ztratí událost doručenou těsně po sklizni.

### ADR-0008 — upozornění nejsou peníze

**Rozhodlo se:** best-effort publikace hned po commitu, bez trvanlivé fronty.
Generická obálka (typ jako řetězec a JSON tělo) místo doménového schématu.
Expirace a deduplikace na straně konzumenta.

**Bereme si:** záruky doručení jsou pro peníze. U upozornění by zaručené doručení
navíc doručovalo *zastaralou* zprávu. A drátová hodnota typu je zároveň
rozlišovačem u klienta, takže existuje **jeden** řetězec, ne tři konstanty, které
se během půl roku rozejdou.

### ADR-0009 — abstrahuj transport, ne brokera

**Rozhodlo se:** emulátor cloudové sběrnice byl kódově neproveditelný. Vznikl
lokální transport za **stejným** rozhraním producenta a se stejnými handlery.

**Bereme si:** lokální běh bez placených účtů je vlastnost, ne pohodlí. A limity
takové náhrady — žádné opakování, žádná validace schématu — se vypíšou nahlas,
místo aby se mlčky dědily.

### ADR-0010 — autoritativní asynchronní relace

**Rozhodlo se:** odměnu počítá server z faktů (částka dodaná klientem byla
důvodem k zastavení vydání). Snímek je malý **strukturovaný dokument** v databázi,
ne blob v objektovém úložišti; neměnný, verzovaný, zmrazený při publikaci.
Zmrazený snímek znamená žádné zámky pro N souběžných hráčů. Log akcí se nahrává
**od prvního dne**. Validace je dvouúrovňová: levný filtr všude, drahá re-simulace
jen pro žebříček.

**Bereme si:** log, který se nenahrával od začátku, se nedá doplnit zpětně. A jedno
varování navíc: debata tam předepsala konkrétní typ databázového sloupce podle
špatného enginu — **princip drž, konkrétní technický detail ověř proti realitě.**

### ADR-0011 — přehrání ověřuje vstupy, ne výsledky

**Rozhodlo se:** autorita je artefakt autorovaný důvěryhodným serverem, podepsaný
a obsahově adresovaný; v databázi jen hash, adresa, velikost a verdikt. K němu
deterministická re-simulace.

**Bereme si:** nejdůležitější poučení pro deterministický interpret v tomhle
repozitáři. **Záznam musí obsahovat vstupy, ne výstupy** — původní návrh chtěl
přehrávat log výsledků, kde není co spustit. Dál: *omezená pravidlová sada je
produktové rozhodnutí, které determinismus teprve umožní* — pevný tik, celočíselná
aritmetika na rozhodovací cestě, žádné výsledky odvozené z fyziky — ukotvená
hashem pravidel, buildu, snímku a seedu. A neshoda dvou běhů znamená **neudělit a
označit**, nikdy potrestat.

### ADR-0012 — sink je vyměnitelný, emisní body ne

**Rozhodlo se:** telemetrie po existujícím transportu do jedné tabulky událostí v
každé službě, agregace dotazem, čtení přes administrátorský endpoint. Žádná nová
metrická infrastruktura.

**Bereme si:** drahé jsou emisní body v kódu, ne úložiště za nimi. Volit databázi
časových řad dřív, než existuje problém se škálou, je předčasné — a lokálně se to
netestuje.

### ADR-0013 — moderace musí být bezplatně vratná

**Rozhodlo se:** administrátorská identita jako vlastní odvolatelný, expirovatelný
a atribuovatelný rozsah oprávnění, ne statické sdílené tajemství. Stažení obsahu
je **přidaný stavový sloupec a filtr ve výpisu**, nikdy smazání řádku — smazání je
vyhrazené pro výmaz na žádost. Každá administrátorská změna píše audit s aktérem a
stavem před a po.

**Bereme si:** nevratnou moderaci si nikdo netroufne použít, takže se nepoužívá
vůbec. Vratnost je to, co z ní dělá nástroj.

### ADR-0014 — invariant, který kontroluje stroj

**Rozhodlo se:** dvě měny se záměrně nepropojily (slabý kurz je nejhorší střed —
pro běžného hráče dekorace, pro automatizovaného farma). Účetnictví rozlišuje
**provenienci** hodnoty a vrácení peněz sahá jen na koupenou část. Útěcha za
prohru je podmíněná účastí a její příznak musí být rozhodnutý serverem a stabilní
při přehrání. Strop hromádky se kotví na dny akruálu, ne na kupní sílu.

**Bereme si:** napiš si strojově kontrolovaný invariant, třeba „denní příjem
nepřesáhne polovinu ceny hlavního odtoku". Bez něj drží rovnováha jen v hlavě
toho, kdo ji navrhl.

### ADR-0015 — eskalační žebřík místo jedné velké záplaty

**Rozhodlo se:** tam, kde autoritativní proces běží na stroji uživatele, je
zpřísnění rozsahu oprávnění divadlo. Místo toho identita **z ověřeného tokenu, ne
z těla požadavku**, a krátkodobé podepsané oprávnění vázané na trojici
(identifikátor epizody, uživatel, expirace), vydané při startu a vyžádané při
ukončení.

**Bereme si:** zbytkovou díru vypiš a **nikdy ji nehlas jako uzavřenou**. Postav
žebřík — identita, pak oprávnění, pak ekonomické stropy, pak re-simulace — místo
jednoho „zabezpečíme to potom".

---

## ECA doktrína — a proč je tahle sekce z poloviny prázdná

Tenhle projekt staví na deklarativním grafu **událostí, podmínek a akcí**, který
spouští ručně psaný deterministický interpret. Zadání téhle úlohy chtělo z pramenů
vytáhnout *výběr primitiv, který se osvědčil u neprogramátorů*.

**Takový doklad v pramenech není. Ani jeden.** Prameny nepopisují deklarativní
graf, žádný jazyk pro autory, žádné uživatelské testování a žádnou primitivu,
která by se po testu odstranila nebo přejmenovala. Jediný „autor" v celém korpusu
je hráč, který rozmisťuje objekty a ladí čísla u předpřipravených archetypů.

Vydávat odvození za měření by z tohohle dokumentu udělalo horší zdroj, než je
prázdná stránka. Co následuje jsou proto **tvary primitiv odvozené z mechanismů**,
které v pramenech doloženy jsou — označené jako analogie, ne jako evidence o
srozumitelnosti:

- **„když protne práh, ořízni a přebytek zahoď"** — strop je první třída, ne
  dodatečná podmínka, a přetečení má definovaný osud.
- **„když skončí epizoda, vyhodnoť výsledek a proveď právě jeden efekt"** — dva
  příjemci znamenají dva zápisy v téže transakci, ne dvě zprávy.
- **„odměň hned přítomného, odlož a nastřádej nepřítomnému"** — dvě kadence téhož
  efektu jsou dvě primitivy, ne jedna s příznakem.
- **podmínka se smí opřít jen o fakt, který si interpret odvodí ze svého stavu** —
  nikdy o hodnotu dodanou zvenčí. V pramenech je to bezpečnostní pravidlo; tady je
  to totéž pravidlo pro reprodukovatelnost.
- **autorský rozpočet jako viditelný semafor** — každý přidaný prvek má cenu na
  několika nezávislých osách, existuje strop a přes strop se prvek nepřidá.
- **validátor odmítne obsah před uložením, ne až za běhu** — a v hlášce je
  konkrétní číslo.
- **parametrizovaný archetyp místo psaní chování** — autor mění pár čitelných čísel
  nad hotovou knihovnou úloh.
- **zmrazení verze při publikaci, ne při každé editaci** — rozběhnuté relace
  dojedou na verzi, se kterou začaly.
- **omezená sada operací ukotvená hashem** — co je mimo sadu, do jazyka nepatří, a
  verze sady je součástí identity záznamu.

Čemu se prameny naopak vyhýbají v hodnoceném stavu: cokoliv řízené reálným časem,
výsledky odvozené z fyziky, a plovoucí desetinná čárka na rozhodovací cestě.

---

## Provozní vzory

- **Readiness** — zdravotní kontrola s vypínačem externích integrací; v lokálním
  režimu ověří jen úložiště a nastartuje bez cloudových přihlašovacích údajů.
- **Admission control** — levný filtr věrohodnosti (minimální trvání, strop počtu
  událostí odvozený ze snímku, frekvence na uživatele) běží jako první brána
  všude; drahá validace jen tam, kde se hraje o žebříček.
- **Deadline** — zpráva nese vlastní expiraci a konzument ji po vypršení zahodí.
  Zastaralé upozornění je horší než žádné.
- **Deduplikace** — deterministický klíč z identifikátorů epizody a příjemce,
  idempotence vynucená u příjemce; u odesílatele jen ohraničená paměť.
- **Watchdog a dávkové odesílání** — trvanlivá fronta v databázi a úloha na
  pozadí, která ji ve smyčce vyprazdňuje a značí odeslané. Vyhrazeno pro peníze.
- **Transport událostí** — jedna sdílená obálka s typem jako řetězcem, per-službu
  vlastní konzumní skupina a samofiltrace: co nemám čím obsloužit, potvrdím a
  přeskočím.
- **Validace přehráním** — podepsaný obsahově adresovaný artefakt nesoucí hash
  pravidel, buildu a snímku, seed, proud vstupů a tvrzený výsledek. Odměna zůstává
  v „čeká na ověření", dokud validátor nedá zelenou.
- **Hranice důvěry mezi stroji** — identita z ověřeného tokenu, nikdy z těla
  požadavku; krátkodobé podepsané oprávnění váže start epizody na její ukončení.
- **Audit** — každá operátorská změna zapíše aktéra, cíl a stav před a po.

---

## Co se do dokumentu nedostalo

Zadrženo bylo jen to, co je vlastnické jméno — počty a kategorie, ne názvy:

| Kategorie | Počet |
|---|---|
| názvy backendových služeb | 8 |
| názvy repozitářů a projektů | 16 |
| názvy produktů | 3 |
| identifikátory tříd, rozhraní, handlerů, komponent a pluginů | přes 90 |
| názvy tabulek, entit a sloupců | ~35 |
| cesty endpointů | ~13 |
| uložené procedury | 1 |
| konfigurační klíče a názvy tajemství | 5 |
| názvy externích generativních API a SDK | 5 |
| název herní měny | 1 |
| organizační hostingová adresa | 1 |
| lokální databázové údaje (host, port, jméno) | 2 |

**Poučení vynechané kvůli nevyslovitelnosti: žádné.** Každé rozhodnutí ze všech
patnácti záznamů šlo popsat mechanismem bez jediného jména.
