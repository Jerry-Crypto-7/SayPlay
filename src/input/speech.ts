/**
 * Diktování věty hlasem — rozpoznávání řeči, které prohlížeč umí sám.
 *
 * Je to samostatný modul bez JSX ze stejného důvodu jako `promptOutcome.ts`:
 * rozhoduje se tu, jestli se tlačítko vůbec nabídne a co z řeči vyleze jako
 * text, a to je logika s vlastním testem v Node. `PromptBar.tsx` z toho jen
 * kreslí.
 *
 * ## Nic se nestahuje a nic neodchází ven
 *
 * `SpeechRecognition` je rozhraní prohlížeče, ne naše závislost — do balíku
 * nepřibývá bajt a licenční brána nemá co řešit. Chrome si přepis řeší po svém
 * (historicky posílá zvuk na server Googlu); **my nedržíme zvuk ani ho nikam
 * neposíláme** a dostaneme jenom hotový text zpátky.
 *
 * ## Tři věci, které se tu nesmí rozmazat
 *
 * 1. **Prefix je pravidlo, ne výjimka.** Chrome vystavuje výhradně
 *    `webkitSpeechRecognition`; neprefixované jméno ze specifikace má dnes málokdo.
 *    Číst jen jedno z nich znamená vypnout diktování v prohlížeči, který ho umí.
 * 2. **Nedostupnost je odpověď, ne chyba.** Firefox rozhraní nemá vůbec. Tlačítko
 *    se tam podle AC **nesmí objevit** — vypnuté tlačítko nabízí něco, co nikdy
 *    nepůjde, a to je horší než žádné.
 * 3. **Diktuje se anglicky.** Rozpoznávač tvarů vět (`src/model/local/shapes.ts`)
 *    čte výhradně anglické tvary. Česky nadiktovaná věta by přepisem prošla a
 *    rozbila se až o produkt, kde už by to nikdo nespojil s nastavením jazyka.
 */

/** Jazyk diktování. Viz bod 3 v hlavičce — není to volba, je to důsledek. */
export const DICTATION_LANG = 'en-US';

/** Jedna alternativa přepisu. Prohlížeč jich vydá víc; bere se ta první. */
export interface RecognitionAlternative {
  readonly transcript?: unknown;
}

/**
 * Jeden úsek řeči. Je to pole alternativ s příznakem `isFinal` — `false` znamená
 * průběžný odhad, který se ještě změní.
 */
export interface RecognitionResult extends ArrayLike<RecognitionAlternative> {
  readonly isFinal?: boolean;
}

export interface RecognitionResultEvent {
  readonly results: ArrayLike<RecognitionResult>;
}

/** Minimum z `SpeechRecognition`, které tenhle modul používá. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
  onend: (() => void) | null;
}

export type RecognitionConstructor = new () => RecognitionLike;

/** Okno se injektuje, aby šly větve otestovat jinak než čtyřmi prohlížeči. */
export interface WindowLike {
  readonly SpeechRecognition?: RecognitionConstructor;
  readonly webkitSpeechRecognition?: RecognitionConstructor;
}

export interface DictationHandlers {
  /** Hotový přepis. Volá se jen s neprázdným textem. */
  readonly onText: (text: string) => void;
  /** Kód chyby prohlížeče, například `not-allowed` u zamítnutého mikrofonu. */
  readonly onError?: (code: string) => void;
  /** Konec poslouchání, ať už řečí, tichem nebo chybou. */
  readonly onEnd?: () => void;
}

export interface DictationSession {
  stop(): void;
}

function globalWindow(): WindowLike | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as WindowLike);
}

/** Konstruktor rozpoznávače, nebo `null`, když ho tenhle prohlížeč nemá. */
export function recognitionConstructorOf(win: WindowLike | undefined): RecognitionConstructor | null {
  const candidate = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
  return typeof candidate === 'function' ? candidate : null;
}

/**
 * Umí tenhle prohlížeč diktování?
 *
 * Mimo prohlížeč (server, prerender) vrací `false` — a musí. Kdyby vrátila
 * `true`, server by tlačítko poslal, klient by ho po hydrataci vzal zpátky a
 * React by hlásil neshodu. Proto se tahle otázka v komponentě klade až po
 * připojení.
 */
export function supportsDictation(win: WindowLike | undefined = globalWindow()): boolean {
  return recognitionConstructorOf(win) !== null;
}

/**
 * Text z události rozpoznávače.
 *
 * **Průběžné úseky se zahazují.** Prohlížeč je posílá jako předponu té samé
 * věty, takže brát je znamená vyrobit „a puzzle a puzzle room". Relace je
 * nastavená tak, že žádné chodit nemají — tohle je pojistka na okraji, kde se
 * mluví s cizím rozhraním.
 */
export function transcriptOf(event: RecognitionResultEvent): string {
  const results = event.results;
  const parts: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result === undefined || result.isFinal === false) continue;
    const transcript = result[0]?.transcript;
    if (typeof transcript === 'string' && transcript.trim() !== '') parts.push(transcript.trim());
  }
  return parts.join(' ');
}

/**
 * Spustí jednu relaci diktování. Vrátí `null`, když prohlížeč rozhraní nemá nebo
 * se relace nerozeběhla — volající pak neblikne stavem „poslouchám", který by
 * nikdy neskončil.
 */
export function startDictation(
  handlers: DictationHandlers,
  win: WindowLike | undefined = globalWindow(),
): DictationSession | null {
  const Recognition = recognitionConstructorOf(win);
  if (Recognition === null) return null;

  const recognition = new Recognition();
  recognition.lang = DICTATION_LANG;
  // Jedna věta, žádné průběžné výsledky: relace skončí sama, jakmile člověk
  // domluví, a text dorazí právě jednou.
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const text = transcriptOf(event);
    if (text !== '') handlers.onText(text);
  };
  recognition.onerror = (event) => {
    handlers.onError?.(typeof event.error === 'string' && event.error !== '' ? event.error : 'unknown');
  };
  recognition.onend = () => handlers.onEnd?.();

  try {
    recognition.start();
  } catch {
    // `start()` nad už běžícím rozpoznávačem vyhodí `InvalidStateError`. Kdyby
    // to proletělo ven, spadne obsluha kliknutí a s ní i formulář kolem ní.
    handlers.onError?.('start-failed');
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // Relace už skončila sama. Zastavovat hotové není chyba k hlášení.
      }
    },
  };
}
