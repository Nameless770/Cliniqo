/**
 * Client environment.
 *
 * Anything here is inlined into the JavaScript bundle at build time and is readable by
 * anyone who opens devtools. It is therefore PUBLIC, permanently — a value that ships
 * once cannot be unshipped from a browser cache.
 *
 * The list is deliberately almost empty. If a value is needed on the client, that is a
 * signal to move the logic to the server, not to add a variable here.
 *
 * NEVER put in this file: connection strings, session secrets, API keys of any kind, or
 * anything derived from patient data.
 *
 * Next.js only inlines variables literally prefixed `NEXT_PUBLIC_`, and only where they
 * appear as `process.env.NEXT_PUBLIC_X` in source. Destructuring `process.env` does not
 * work on the client — hence the explicit references below.
 */

import { z } from 'zod';

const schema = z.object({
  /** Display name in the page title and header. Not sensitive. */
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Cliniqo'),
});

const parsed = schema.safeParse({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
});

if (!parsed.success) {
  throw new Error(
    `Invalid public environment configuration:\n` +
      parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
  );
}

export const clientEnv = parsed.data;
