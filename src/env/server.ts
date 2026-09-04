/**
 * Server environment — validated once, at startup.
 *
 * SERVER ONLY. `server-only` makes importing this from a Client Component a build error
 * rather than a runtime surprise, because every value here is a secret or a
 * secret-adjacent connection detail.
 *
 * Validation runs at process start via `src/instrumentation.ts`, not lazily on first use.
 * A missing SESSION_SECRET should stop the deployment, not surface as a 500 the first
 * time somebody tries to log in.
 */

import 'server-only';

import { z } from 'zod';

/* -------------------------------------------------------------------------- */

const booleanish = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    /* --- Runtime ---------------------------------------------------------- */
    /**
     * Set by the build tool, not by the operator. `next build` forces this to
     * "production" regardless of where the build runs, so it says how the code was
     * compiled — never which environment it is serving.
     */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /**
     * Operator-controlled deployment environment. This — not NODE_ENV — gates the
     * production invariants below.
     *
     * Keying them off NODE_ENV would mean a production-mode build on a laptop, or in CI,
     * fails because the developer has no production TLS certificate. That pressure is
     * exactly how a `rejectUnauthorized: false` ends up committed to make the build pass.
     */
    APP_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),

    /**
     * Absolute base URL. Used for cookie scoping and absolute links. Required in
     * production: guessing it from request headers is how host-header injection turns
     * into a password-reset link pointing at an attacker's domain.
     */
    APP_URL: z.url().optional(),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    /* --- Database --------------------------------------------------------- */
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgres:// connection string',
      }),

    /**
     * TLS to the database. Encryption in transit includes the application-to-database
     * hop — the one people forget.
     */
    DATABASE_SSL: z.enum(['verify', 'disable']).default('verify'),

    /** PEM CA bundle. Optional when the provider's CA is already in the system store. */
    DATABASE_CA_CERT: z.string().optional(),

    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /* --- Sessions --------------------------------------------------------- */
    /**
     * Signing key for session cookies. 32 bytes minimum.
     * Generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
     */
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

    /** Automatic logoff — §164.312(a)(2)(iii). Slides forward on activity. */
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),

    /** Hard ceiling regardless of activity. Does not slide. */
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(24).default(12),

    /* --- Rate limiting ---------------------------------------------------- */
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
    AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

    /* --- Escape hatch ----------------------------------------------------- */
    /**
     * Seed data is synthetic (§164.514 — no production PHI in development or test).
     * Guarded so the seeder can never be triggered against a production database.
     */
    ALLOW_SEED_DATA: booleanish.default(false),
  })
  /* --- Production-only invariants ----------------------------------------- */
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== 'production') return;

    if (env.DATABASE_SSL === 'disable') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message: 'DATABASE_SSL=disable is not permitted in production.',
      });
    }

    if (!env.APP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL is required in production.',
      });
    }

    if (env.APP_URL && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL must use https in production.',
      });
    }

    if (env.ALLOW_SEED_DATA) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_SEED_DATA'],
        message: 'ALLOW_SEED_DATA must be false in production.',
      });
    }

    // Catches a copied .env.example reaching production.
    if (/change[_-]?me|localtest|example/i.test(env.SESSION_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET still looks like a placeholder.',
      });
    }
  });

/* -------------------------------------------------------------------------- */

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

/**
 * Parse and cache. Throws on the first invalid configuration.
 *
 * The error names the failing variables and NEVER echoes their values — an invalid
 * secret is still a secret, and startup errors reach log aggregators, terminals, and
 * screenshots.
 */
export function loadServerEnv(): ServerEnv {
  if (cached) return cached;

  const result = schema.safeParse(process.env);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .sort()
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        `See .env.example for the full list of variables.`,
    );
  }

  cached = result.data;
  return cached;
}

/**
 * Accessor for validated configuration.
 *
 * A function, not an eagerly-evaluated constant. Module-scope evaluation would run during
 * `next build` — when Next imports route modules to collect page data — and a build is
 * environment-independent: it must not require a database URL or a session secret.
 *
 * Validation still happens once, at server start, via `src/instrumentation.ts`. This is
 * lazy, not deferred-until-something-breaks.
 */
export function getEnv(): ServerEnv {
  return loadServerEnv();
}
