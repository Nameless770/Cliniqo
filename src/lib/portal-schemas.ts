import { z } from 'zod';

/**
 * Patient portal input validation. Isomorphic — shapes only, no PHI.
 */

export const portalLoginInput = z
  .object({
    email: z.string().trim().min(1, 'Enter your email.').max(320),
    password: z.string().min(1, 'Enter your password.').max(1024),
  })
  .strict();

/**
 * Same password policy as staff: length over composition. A 12-character passphrase beats
 * a mangled short word on every measure that matters.
 */
export const portalClaimInput = z
  .object({
    token: z.string().min(20).max(200),
    password: z
      .string()
      .min(12, 'Use at least 12 characters. A short phrase works well.')
      .max(1024),
    confirm: z.string(),
  })
  .strict()
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Those do not match.',
  });

export const portalBookInput = z
  .object({
    providerUserId: z.uuid('Choose a clinician.'),
    appointmentTypeId: z.uuid('Choose a visit type.'),
    startsAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Choose a date and time.'),
  })
  .strict();

export type PortalBookInputParsed = z.infer<typeof portalBookInput>;
