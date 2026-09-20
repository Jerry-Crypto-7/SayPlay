/** `counter`: ohraničené číslo, které hra sleduje. Jen deklarace – kdo ho mění, je jiná mechanika. */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter } from '../types';

type Params = z.infer<(typeof MECHANICS)['counter']['params']>;

export const counter: MechanicAdapter<Params> = (params) => ({
  counters: { [params.id]: { min: params.min, max: params.max, init: params.initial } },
  rules: {},
});
