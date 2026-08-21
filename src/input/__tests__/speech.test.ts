import { describe, expect, it, vi } from 'vitest';

import {
  DICTATION_LANG,
  startDictation,
  supportsDictation,
  transcriptOf,
  type RecognitionLike,
  type RecognitionResultEvent,
  type WindowLike,
} from '../speech';

/**
 * Oracle T23 — **diktování se nabízí jen tam, kde ho prohlížeč umí.**
 *
 * Obě větve AC se rozhodují tady, ne v komponentě: `PromptBar` z toho jen
 * kreslí nebo nekreslí tlačítko. Testuje se proto rozhodnutí, ne JSX.
 *
 * Rozpoznávač je vstup funkce, ne globální objekt — jinak by se nedaly změřit
 * čtyři různé prohlížeče (Chrome s prefixem, spec bez prefixu, Firefox bez
 * obojího, a server, kde `window` vůbec není) jinak než čtyřmi prohlížeči.
 */

/** Rozpoznávač, který nic nedělá sám od sebe — událost mu pošle test. */
class FakeRecognition implements RecognitionLike {
  lang = '';
  continuous = true;
  interimResults = true;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: { readonly error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0;
  stops = 0;
  /** Když je nastavené, `start()` vyhodí — tak, jak to dělá už běžící rozpoznávač. */
  failStart: Error | null = null;

  start(): void {
    if (this.failStart !== null) throw this.failStart;
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }
}

/** Jeden výsledek tak, jak ho vydá prohlížeč: pole alternativ s příznakem `isFinal`. */
function resultOf(transcript: string, isFinal = true) {
  return Object.assign([{ transcript }], { isFinal });
}

function eventWith(...results: ReturnType<typeof resultOf>[]): RecognitionResultEvent {
  return { results };
}

/** Okno, které rozpoznávač vystavuje pod daným jménem. Instanci si drží test. */
function windowWith(
  name: 'SpeechRecognition' | 'webkitSpeechRecognition',
  recognition: FakeRecognition,
): WindowLike {
  return {
    [name]: function () {
      return recognition;
    } as unknown as new () => RecognitionLike,
  };
}

describe('dostupnost diktování', () => {
  it('bez okna vyjde nedostupné — na serveru se tlačítko nesmí vykreslit', () => {
    // Kdyby tahle větev vracela `true`, server by poslal tlačítko, klient by ho
    // po hydrataci vzal zpátky a React 19 by hlásil neshodu. Proto je to `false`
    // a `PromptBar` čte dostupnost až po připojení.
    expect(supportsDictation(undefined)).toBe(false);
  });

  it('okno bez rozhraní vyjde nedostupné', () => {
    expect(supportsDictation({})).toBe(false);
  });

  it('Chrome vystavuje rozhraní jen pod prefixem, a to stačí', () => {
    expect(supportsDictation(windowWith('webkitSpeechRecognition', new FakeRecognition()))).toBe(true);
  });

  it('neprefixované jméno ze specifikace stačí taky', () => {
    expect(supportsDictation(windowWith('SpeechRecognition', new FakeRecognition()))).toBe(true);
  });

  it('jméno obsazené něčím, co není konstruktor, dostupnost nedělá', () => {
    // Stará rozšíření prohlížeče i polyfilly to na okno vešly jako `undefined`
    // nebo jako obyčejný objekt. `new` nad tím spadne, takže je to nedostupnost.
    expect(supportsDictation({ webkitSpeechRecognition: undefined })).toBe(false);
    expect(supportsDictation({ SpeechRecognition: {} as unknown as new () => RecognitionLike })).toBe(
      false,
    );
  });
});

describe('přepis řeči na text', () => {
  it('spojí hotové úseky mezerou', () => {
    expect(transcriptOf(eventWith(resultOf('a puzzle room'), resultOf('with three keys')))).toBe(
      'a puzzle room with three keys',
    );
  });

  it('rozepsaný úsek zahodí, aby se věta nezdvojila', () => {
    // Průběžný výsledek je předpona té samé věty. Kdyby se bral, vzniklo by
    // „a puzzle a puzzle room" místo „a puzzle room".
    expect(transcriptOf(eventWith(resultOf('a puzzle', false), resultOf('a puzzle room')))).toBe(
      'a puzzle room',
    );
  });

  it('prázdný a chybějící výsledek text nezmění', () => {
    expect(transcriptOf(eventWith(resultOf('   '), resultOf('door')))).toBe('door');
    expect(transcriptOf({ results: [] })).toBe('');
  });
});

describe('relace diktování', () => {
  it('bez rozhraní nevrátí relaci a nikoho nevolá', () => {
    const onText = vi.fn();
    expect(startDictation({ onText }, {})).toBeNull();
    expect(onText).not.toHaveBeenCalled();
  });

  it('rozpoznávač se nastaví na jednu větu v angličtině a spustí se', () => {
    const recognition = new FakeRecognition();
    const session = startDictation({ onText: vi.fn() }, windowWith('webkitSpeechRecognition', recognition));

    expect(session).not.toBeNull();
    expect(recognition.starts).toBe(1);
    // Rozpoznávač tvarů vět (T7) čte výhradně anglicky — česky nadiktovaná věta
    // by přepisem prošla a rozbila se až o produkt, kde už to nikdo nespojí.
    expect(recognition.lang).toBe(DICTATION_LANG);
    expect(DICTATION_LANG.startsWith('en')).toBe(true);
    // Jedna věta, žádné průběžné výsledky: relace končí sama a text dorazí jednou.
    expect(recognition.continuous).toBe(false);
    expect(recognition.interimResults).toBe(false);
  });

  it('hotový přepis dorazí volajícímu', () => {
    const recognition = new FakeRecognition();
    const onText = vi.fn();
    startDictation({ onText }, windowWith('webkitSpeechRecognition', recognition));

    recognition.onresult?.(eventWith(resultOf('a stealth level with guards')));

    expect(onText).toHaveBeenCalledWith('a stealth level with guards');
  });

  it('ticho se za text nevydává', () => {
    const recognition = new FakeRecognition();
    const onText = vi.fn();
    startDictation({ onText }, windowWith('webkitSpeechRecognition', recognition));

    recognition.onresult?.(eventWith(resultOf('  ')));

    expect(onText).not.toHaveBeenCalled();
  });

  it('chyba i konec doletí, aby tlačítko nezůstalo viset v poslouchání', () => {
    const recognition = new FakeRecognition();
    const onError = vi.fn();
    const onEnd = vi.fn();
    startDictation(
      { onText: vi.fn(), onError, onEnd },
      windowWith('webkitSpeechRecognition', recognition),
    );

    recognition.onerror?.({ error: 'not-allowed' });
    recognition.onend?.();

    expect(onError).toHaveBeenCalledWith('not-allowed');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('chyba beze jména se hlásí pod náhradním kódem, ne jako prázdno', () => {
    const recognition = new FakeRecognition();
    const onError = vi.fn();
    startDictation({ onText: vi.fn(), onError }, windowWith('webkitSpeechRecognition', recognition));

    recognition.onerror?.({});

    expect(onError).toHaveBeenCalledWith('unknown');
  });

  it('pád při spuštění nevyletí ven a relace nevznikne', () => {
    // `start()` nad už běžícím rozpoznávačem vyhodí `InvalidStateError`. Kdyby
    // to proletělo, spadne obsluha kliknutí a s ní i formulář kolem ní.
    const recognition = new FakeRecognition();
    recognition.failStart = new Error('InvalidStateError');
    const onError = vi.fn();

    const session = startDictation(
      { onText: vi.fn(), onError },
      windowWith('webkitSpeechRecognition', recognition),
    );

    expect(session).toBeNull();
    expect(onError).toHaveBeenCalledWith('start-failed');
  });

  it('zastavení relace zastaví rozpoznávač a přežije jeho výjimku', () => {
    const recognition = new FakeRecognition();
    const session = startDictation({ onText: vi.fn() }, windowWith('webkitSpeechRecognition', recognition));

    session?.stop();
    expect(recognition.stops).toBe(1);

    recognition.stop = () => {
      throw new Error('už skončil');
    };
    expect(() => session?.stop()).not.toThrow();
  });
});
