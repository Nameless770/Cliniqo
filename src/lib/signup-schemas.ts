import { z } from 'zod';

/**
 * A staff member requesting access supplies only their name.
 *
 * The email is the one Google verified, read from the signed sign-up token. Roles are
 * deliberately absent: the person requesting access does not get a say in what access
 * they get. An administrator decides that on the Staff screen.
 */
export const staffSelfSignupInput = z
  .object({
    fullName: z
      .string({ message: 'Your name is required.' })
      .trim()
      .min(1, 'Your name is required.')
      .max(120, 'Your name must be 120 characters or fewer.'),
  })
  .strict();

/**
 * A staff member creating an account with an email and a password.
 *
 * Still no roles: what access a new account gets is an administrator's decision, never a field
 * on a public form.
 */
export const staffPasswordSignupInput = z
  .object({
    email: z
      .string({ message: 'Enter your work email address.' })
      .trim()
      .toLowerCase()
      .min(1, 'Enter your work email address.')
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'),
    fullName: z
      .string({ message: 'Your name is required.' })
      .trim()
      .min(1, 'Your name is required.')
      .max(120, 'Your name must be 120 characters or fewer.'),
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
