import type { GenreSpec } from '../genre/contract';
import type { GameRole, GameSpecV1 } from '../spec';

/** Keep authored content for the common spec validator; unsupported rules must
 * be rejected explicitly instead of disappearing during native assembly. */
export function withAuthoredContent(game: GameSpecV1, content: GenreSpec): GameSpecV1 {
  const extra = (content.ruleRoles ?? []).filter(role => !game.roles.some(own => own.id === role.id))
    .map(role => ({ count: 1, ...role }) as GameRole);
  return {
    ...game,
    ...(extra.length === 0 ? {} : { roles: [...game.roles, ...extra] }),
    ...(content.rules?.length ? { rules: content.rules } : {}),
    ...(content.things?.length ? { things: content.things } : {}),
    ...(content.heroAction === undefined ? {} : { heroAction: content.heroAction }),
  };
}
