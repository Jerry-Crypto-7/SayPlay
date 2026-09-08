# Holdout v1 — před inferencí

Deset nově napsaných zdrojů (5 úplných, 3 s chybějící délkou spuštění timeru, 2 s konfliktem délek), pro každý předem napsaný zásah a případná odpověď. Muzeum v této sadě není. 32 atomických požadavků na případ má vlastní přesný byte span. Oracle vznikl před generováním, z textového zadání, nikoli z modelových výsledků.

`suite.json` obsahuje vstupy. `tasks.json` popisuje uživatelské kroky. `oracle.json` obsahuje očekávání a protipříklady a nikdy se neposílá provideru. `manifest.json` kontroluje všechny tři soubory. Během přípravy nebyla nad touto sadou provedena žádná modelová inference; strukturální test locku není modelovým laděním.

Všechny případy patří do úzké třídy jednorázových časovaných postupů se dvěma stanovišti. Prostředí a časy se liší, ale nejde o deset různých mechanismů ani důkaz obecného pokrytí procedur. To odpovídá podporovanému timer zásahu pilotu. Pro rozšíření hypotézy bude potřeba nová sada s jinými mechanismy.

Při ladění podle výsledků označit sadu jako development a vytvořit novou. Nevybírat jen úspěšné běhy. Lokální hash je detekce změny, ne veřejně neměnná kotva.
