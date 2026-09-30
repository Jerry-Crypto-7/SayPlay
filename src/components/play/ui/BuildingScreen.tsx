/**
 * Stavba hry podle kitu Sayplay (P34 T4, `07-components.md` – Generation
 * progress): nahoře věta hráče v `display-m`, pod ní `.sp-steps` se čtyřmi
 * kroky `BUILD_STEPS`. Hotový krok má mátovou fajfku, běžící pulzuje slunečně,
 * budoucí je čárkovaný. Pohybuje se jen puls běžícího kroku (`09-motion.md`),
 * proto tu už není běžící pruh z P33 T14. Pozadí v tónu nálady věty.
 *
 * `title` chybí u scény, která jen dotahuje kód (`ArcadePlay`, `GridShell`):
 * název tam nese pruh HUD nahoře a pod plátnem je obloha sady (P32D T6), proto
 * bez pozadí – kroky leží na papírové kartě a běží třetí z nich, první dva
 * odškrtla už stránka `/play`.
 */

import type { MoodTone } from '../Feed';
import { BUILD_STEPS } from '../starters';
import { Icon } from './icons';

/** Krok, na kterém je scéna `/play/[id]`: věta je přečtená a svět postavený. */
const STAGE_STEP = 2;

/** Průběh stavby: všechny čtyři kroky, hotové odškrtnuté, aktivní zvýrazněný. */
export function BuildSteps({ active }: { readonly active: number }) {
  return (
    <ol className="sp-steps" data-testid="play-status" aria-live="polite">
      {BUILD_STEPS.map((step, index) => {
        const state = index < active ? 'done' : index === active ? 'active' : 'todo';
        return (
          <li
            key={step}
            className={state === 'done' ? 'sp-steps__item is-done' : state === 'active' ? 'sp-steps__item is-current' : 'sp-steps__item'}
            data-state={state}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="sp-steps__mark">{state === 'done' && <Icon name="check" />}</span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}

export function BuildingScreen({ title, tone, step = STAGE_STEP }: { readonly title?: string; readonly tone?: MoodTone; readonly step?: number }) {
  return (
    <div className={title === undefined ? 'play-loading play-loading-stage' : 'play-loading'} data-testid="play-loading" data-tone={tone} aria-busy="true">
      {title !== undefined && <p className="sp-display-m play-loading-title">{title}</p>}
      <BuildSteps active={step} />
    </div>
  );
}
