import { z } from 'zod';

/** Named gameplay parts. The role points at a real, rendered GameSpec role. */
export const assemblyPartSchema = z.object({
  kind: z.enum(['catch', 'rival', 'hazard', 'chaser', 'fight', 'duel', 'deliver', 'interact', 'escape']),
  role: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
  phase: z.union([z.literal(0), z.literal(1)]).default(0),
  motion: z.enum(['fall', 'fly']).default('fall'),
}).strict();
export const assemblyPartsSchema = z.array(assemblyPartSchema).max(12);
export type AssemblyPart = z.infer<typeof assemblyPartSchema>;
