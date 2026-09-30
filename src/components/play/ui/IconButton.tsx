/**
 * Kulaté tlačítko s ikonou podle kitu: kolo `.sp-btn--icon` 52 px, pod ním
 * volitelný popisek. Stisk celého tlačítka kolo zamáčkne (`play.css`).
 * `aria-label` je povinný v typu – ikona bez jména je tlačítko, které čtečka
 * neumí přečíst a hráč nepozná.
 */

import type { ButtonHTMLAttributes } from 'react';

import { Icon, type IconName } from './icons';

export function IconButton({
  icon,
  caption,
  className,
  type = 'button',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
  readonly 'aria-label': string;
  readonly icon: IconName;
  readonly caption?: string;
}) {
  return (
    <button type={type} className={className === undefined ? 'play-icon-button' : `play-icon-button ${className}`} {...rest}>
      <span className="sp-btn sp-btn--icon play-icon-button-disc">
        <Icon name={icon} />
      </span>
      {caption !== undefined && <span className="play-icon-button-caption">{caption}</span>}
    </button>
  );
}
