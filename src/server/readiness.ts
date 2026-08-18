/**
 * Readiness — **skutečný zápis, ne ping.**
 *
 * Naivní readiness se ptá, jestli cesta existuje, a odpoví „ano" i tehdy, když
 * je svazek připojený jen pro čtení, když je disk plný nebo když kvóta došla.
 * Ve všech třech případech proces běží, port poslouchá, a **první požadavek,
 * který potřebuje něco zapsat, selže** — tedy přesně ve chvíli, kdy už na něj
 * vyvažovač poslal provoz, protože readiness řekla, že je připraveno.
 *
 * Tahle sonda proto projde celý cyklus, který produkční cesta dělá taky:
 * **zapíše, přečte zpátky, porovná, uklidí.** Každý ze čtyř kroků má vlastní
 * důvod:
 *
 * | Krok | Co odhalí, co ping neodhalí |
 * |---|---|
 * | zápis | svazek jen pro čtení, plný disk, vyčerpaná kvóta, chybějící právo |
 * | čtení zpátky | zápis, který se tvářil úspěšně a nic neuložil |
 * | porovnání | vrstva, která vrací cizí nebo zastaralý obsah |
 * | úklid | adresář, do kterého sonda zapisuje a nemaže — sama ho zaplní |
 *
 * Poslední řádek není puntičkářství. Readiness se volá každých pár vteřin po
 * celou dobu běhu, takže sonda, která po sobě neuklidí, je jediný komponent
 * s jistotou, že disk dřív nebo později zaplní.
 *
 * ## Selhání se vrací, nevyhazuje
 *
 * Volající je obslužná rutina zdravotní kontroly. Ta musí odpovědět vždycky —
 * výjimka z readiness by se vykreslila jako 500 a od 503 ji nikdo nerozliší,
 * přitom je to jiný stav: 503 znamená „běžím a nejsem připraven", 500 znamená
 * „jsem rozbitý". Sonda proto vrací verdikt a nevyhazuje nikdy.
 */

/** Souborové operace, které sonda potřebuje. Parametr, aby šlo testovat selhání. */
export interface ReadinessFs {
  write(path: string, bytes: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export type ReadinessFailure =
  /** Zápis neprošel — svazek jen pro čtení, plný disk, chybějící právo. */
  | 'WRITE_FAILED'
  /** Zapsané se nedá přečíst zpátky. */
  | 'READ_FAILED'
  /** Přečetlo se něco jiného, než co se zapsalo. */
  | 'READBACK_MISMATCH'
  /** Zápis i čtení prošly, ale sonda po sobě neumí uklidit. */
  | 'CLEANUP_FAILED';

export interface Ready {
  readonly ready: true;
  readonly probePath: string;
  readonly elapsedMs: number;
}

export interface NotReady {
  readonly ready: false;
  readonly probePath: string;
  readonly elapsedMs: number;
  readonly reason: ReadinessFailure;
  /** Co k tomu řekl souborový systém. Jde do logu, ne do odpovědi. */
  readonly detail: string;
}

export type Readiness = Ready | NotReady;

export interface ReadinessDeps {
  readonly fs: ReadinessFs;
  /** Nástěnné hodiny. Readiness není na replay cestě, měřit dobu tu smí. */
  readonly now: () => number;
  /**
   * Odlišení souběžných sond. Dvě sondy nad týmž adresářem si jinak přepíšou
   * soubor a jedna z nich přečte cizí obsah — tedy `READBACK_MISMATCH` na
   * zdravém disku, což je horší než žádná kontrola.
   */
  readonly nonce: () => string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Projde cyklus zápis → čtení → porovnání → úklid nad `directory`.
 *
 * Uklízí i po neúspěšném porovnání: soubor v tu chvíli existuje a nechat ho
 * tam by znamenalo, že rozbitý svazek se zaplní rychleji než zdravý.
 */
export async function checkReadiness(directory: string, deps: ReadinessDeps): Promise<Readiness> {
  const started = deps.now();
  const token = deps.nonce();
  const probePath = `${directory}/readiness-${token}.probe`;
  const payload = `worldsmith readiness ${token}`;
  const elapsed = (): number => deps.now() - started;

  try {
    await deps.fs.write(probePath, payload);
  } catch (error) {
    // Uklízí se i tady, a není to opatrnost navíc. `ENOSPC` i vyčerpaná kvóta
    // položku **nejdřív založí** a teprve pak selžou, takže bez tohohle by sonda
    // na plném disku nechávala soubor při každém volání — tedy přesně ten
    // scénář, kvůli kterému je úklid součástí cyklu.
    await deps.fs.remove(probePath).catch(() => undefined);
    return { ready: false, probePath, elapsedMs: elapsed(), reason: 'WRITE_FAILED', detail: message(error) };
  }

  let readBack: string;
  try {
    readBack = await deps.fs.read(probePath);
  } catch (error) {
    await deps.fs.remove(probePath).catch(() => undefined);
    return { ready: false, probePath, elapsedMs: elapsed(), reason: 'READ_FAILED', detail: message(error) };
  }

  const matched = readBack === payload;

  try {
    await deps.fs.remove(probePath);
  } catch (error) {
    return { ready: false, probePath, elapsedMs: elapsed(), reason: 'CLEANUP_FAILED', detail: message(error) };
  }

  if (!matched) {
    return {
      ready: false,
      probePath,
      elapsedMs: elapsed(),
      reason: 'READBACK_MISMATCH',
      detail: `zapsáno ${payload.length} B, přečteno ${readBack.length} B`,
    };
  }

  return { ready: true, probePath, elapsedMs: elapsed() };
}

/**
 * Sonda nad skutečným souborovým systémem.
 *
 * Bez tohohle adaptéru je `checkReadiness` splněná jen tvarem: jediná
 * implementace `ReadinessFs` by byla `Map` v testu, takže tvrzení „provede
 * skutečný zápis" by nikdy žádný zápis neprovedlo. Testy proti němu sahají na
 * opravdový dočasný adresář.
 */
export function nodeReadinessFs(): ReadinessFs {
  return {
    async write(path, bytes) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, bytes, 'utf-8');
    },
    async read(path) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf-8');
    },
    async remove(path) {
      const { unlink } = await import('node:fs/promises');
      await unlink(path);
    },
  };
}
