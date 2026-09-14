# Nová série po opravách — offline kontrakt připraven, živé měření NOT_RUN

Stav: **NOT_RUN**. Tento adresář není nový nezávislý holdout ani pozitivní výsledek. Historická sada a série 0143dcc9 se nemění.

Nový [development protokol před/po](protocol.md) má verzovaný TypeScript/Zod kontrakt a offline validaci konfigurace, hashe manifestu, lidského potvrzení, všech plánovaných pokusů a retry historie. Nemá zatím interaktivní live runner ani zmrazené skutečné vstupy/buildy. Reference na artefakty se ověřují zvlášť proti skutečným bytes; validátor neověřuje identitu člověka ani význam. Nový nezávislý holdout, živá latence a lidské výsledky zůstávají NOT_RUN.

Nezávislý autor musí před měřením dodat 10 nových podkladů (5 úplných, 3 neúplné, 2 konfliktní), jejich oddělený oracle a 10 běžných promptů. Nesmí dostat modelové výstupy; generátor nedostane oracle. Sadu a oracle je nutné zamknout před prvním během. Případná sada napsaná při implementaci je pouze development.

Nový protokol musí zahrnout sedm kritických potvrzení před spuštěním. Zaznamenat návrh, případy chybějící/konfliktní opory, skutečné upřesnění, přesné původní zdroje a oddělené doplnění uživatele. Čas od zobrazení parametrů do potvrzení je lidské čekání, nikoli modelová latence. Potvrzení nezvyšuje sémantické review na PASS.

Zachovat původní cíle: 27/30 dokončených párů, všechny kritické invarianty, 15/15 požadovaných zastavení, source medián 30 s / p95 60 s, prompt p95 15 s a edit p95 8 s. Výkonový FAIL neznamená změnu development předplatného, modelu ani effort. Výsledky manuálního review a pěti lidí zůstanou samostatné.

Historický browserový live adapter nyní odmítne start s `PARAMETER_REVIEW_REQUIRED` před prvním modelovým voláním. Obnovení živého benchmarku vyžaduje implementaci verzovaného protokolu a jeho interaktivního průchodu; automatické vyplnění nového potvrzení není řešení.
