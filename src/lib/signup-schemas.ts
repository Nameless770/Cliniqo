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
