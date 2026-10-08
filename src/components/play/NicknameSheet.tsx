'use client';

/**
 * Přezdívka z obrazovky výsledku (P44B T10): pod žebříčkem papírový řádek „Playing as Swift Otter ·
 * Change“; „Change“ otevře list s polem „Your name on the board“. „Save“ pošle `PUT /api/play/me`
 * (`me-client.ts`) a `onSaved` řekne výsledku, ať žebříček načte znovu – jinak by v něm zůstalo staré
 * jméno a změna by vypadala hotová. Jména vypnutá na serveru (`503`) = řádek se nekreslí.
 */

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import { fetchMe, knownName, saveNickname } from './me-client';
import { Button, Sheet } from './ui';

/**
 * List se jménem; kreslí se jen otevřený, takže každé otevření začíná od uloženého jména.
 * `onDone(jméno)` = uloženo, `onDone(null)` = jména jsou vypnutá.
 */
export function NicknameSheet({ nickname, onDone, onClose }: { readonly nickname: string; readonly onDone: (saved: string | null) => void; readonly onClose: () => void }) {
  const [draft, setDraft] = useState(nickname);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  // Až po `holdSheet` (efekt listu běží dřív než rodičův): fokus se po zavření vrátí na „Change“.
  useEffect(() => {
    field.current?.select();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const saved = await saveNickname(draft);
    setBusy(false);
    if (saved.ok) onDone(saved.nickname);
    else if (saved.error === null) onDone(null);
    else setError(saved.error);
  }

  return (
    <Sheet open title="Change your name" onClose={onClose}>
      <form className="play-name-form" data-testid="play-name-form" noValidate onSubmit={(event) => void submit(event)}>
        <div className={error === null ? 'sp-prompt play-name-prompt' : 'sp-prompt play-name-prompt is-error'}>
          <label className="sp-prompt__label" htmlFor={fieldId}>
            Your name on the board
          </label>
          <input
            ref={field}
            id={fieldId}
            className="sp-prompt__field"
            data-testid="play-name-input"
            value={draft}
            autoComplete="nickname"
            enterKeyHint="done"
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : `${fieldId}-error`}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
        </div>
        {error !== null && (
          <p className="sp-field-error" id={`${fieldId}-error`} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="l" className="sp-btn--block" data-testid="play-name-save" disabled={busy} aria-busy={busy}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}

/** Řádek „Playing as … · Change“ s listem; jméno ze stránky, jinak z `GET /api/play/me`. */
export function PlayingAs({ onSaved }: { readonly onSaved: () => void }) {
  const [name, setName] = useState<string | null>(() => knownName() ?? null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (knownName() !== undefined) return;
    const control = new AbortController();
    void fetchMe(fetch, control.signal).then((read) => {
      if (!control.signal.aborted) setName(read);
    });
    return () => control.abort();
  }, []);
  if (name === null) return null;
  return (
    <div className="play-playing-as" data-testid="play-playing-as">
      <span>
        Playing as <strong className="play-playing-as-name">{name}</strong> ·
      </span>{' '}
      <Button variant="link" size="s" aria-haspopup="dialog" data-testid="play-name-change" onClick={() => setOpen(true)}>
        Change
      </Button>
      {open && (
        <NicknameSheet
          nickname={name}
          onClose={() => setOpen(false)}
          onDone={(saved) => {
            setOpen(false);
            setName(saved);
            if (saved !== null) onSaved();
          }}
        />
      )}
    </div>
  );
}
