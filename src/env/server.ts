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

    /* --- PHI read throttle ------------------------------------------------- */
    /**
     * Ceiling on PHI reads per actor per window.
     *
     * Not a performance limit — an exfiltration limit. Every read is already audited, so
     * a scrape is reconstructable afterwards; this is what stops it while it happens.
     *
     * Sized well above real clinical use. A busy clinician opens tens of charts in a day;
     * a scraper does thousands in a minute. The gap between those is where this sits.
     */
    PHI_READ_LIMIT: z.coerce.number().int().min(10).max(100_000).default(120),
    PHI_READ_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
    /** Reads per hour above which an actor is surfaced for review. Below the hard limit. */
    PHI_READ_ALERT_PER_HOUR: z.coerce.number().int().min(10).default(200),

    /* --- Escape hatch ----------------------------------------------------- */
    /**
     * Seed data is synthetic (§164.514 — no production PHI in development or test).
     * Guarded so the seeder can never be triggered against a production database.
     */
    ALLOW_SEED_DATA: booleanish.default(false),

    /* --- Symptom triage --------------------------------------------------- */
    /**
     * Which engine answers a patient's symptom description.
     *
     * `local` is the default and makes no network call: the symptom text never leaves
     * this process. `openai` sends it to a third party, which is a disclosure of PHI and
     * is gated below.
     */
    TRIAGE_ENGINE: z.enum(['local', 'openai']).default('local'),

    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),

    /**
     * The operator asserting that a Business Associate Agreement covers the model vendor.
     *
     * A flag rather than a comment because the alternative is a code review catching it,
     * and code reviews do not run at 2am when somebody sets an API key to test something.
     * OpenAI signs a BAA for API use on eligible plans with zero data retention; the FREE
     * tier is not eligible and trains on submitted data, so a free key here is precisely
     * the configuration this exists to keep away from real patients.
     */
    TRIAGE_THIRD_PARTY_BAA_ACKNOWLEDGED: booleanish.default(false),

    /* --- Google sign-in (staff only) -------------------------------------- */
    /**
     * Optional. Absent means the feature does not exist: no button, no routes that do
     * anything, no redirect. Password sign-in is always available and is never replaced.
     */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

    /**
     * Restrict sign-in to one Google Workspace domain, e.g. "fernbrook.example".
     *
     * Strongly recommended and checked server-side against the `hd` claim. Without it any
     * Google account may attempt to sign in — they will still be refused unless their
     * verified address matches a staff account, but narrowing the front door first is
     * cheaper than relying on that one check.
     */
    GOOGLE_ALLOWED_HD: z.string().min(1).optional(),

    /* --- Google sign-in for PATIENTS -------------------------------------- */
    /**
     * Whether patients may connect a Google account to their portal login.
     *
     * OFF BY DEFAULT, and a separate decision from staff sign-in rather than something
     * that follows from having configured GOOGLE_CLIENT_ID. The asymmetry is the point:
     *
     *   A staff member signing in with Google tells Google that one of its users
     *   authenticated to an application. They are an employee. Nothing about that is
     *   health information about anybody.
     *
     *   A PATIENT signing in the same way tells Google that a specific identified person
     *   holds an account at a specific medical practice - which is to say, that they
     *   receive care there. That is health information about that person, disclosed to a
     *   company that signs no Business Associate Agreement for consumer sign-in.
     *
     * It is lawful because the INDIVIDUAL may authorize disclosures about themselves
     * (§164.508), so the flow is opt-in per patient, records the authorization, and can
     * be withdrawn. This flag is the layer above that: the clinic deciding to offer the
     * choice at all. A deployment that leaves it false has no patient Google button, no
     * portal OAuth routes that do anything, and nothing to withdraw.
     */
    PORTAL_GOOGLE_SIGN_IN: booleanish.default(false),

    /* --- Self-registration ------------------------------------------------ */
    /**
     * Which clinic a person joins when they sign themselves up.
     *
     * Required by both flags below. Multi-tenancy is undecided (CLAUDE.md), so this is the
     * single-clinic answer, stated as configuration rather than guessed at runtime: a
     * sign-up page has no session and nothing else that could say which practice the
     * visitor means.
     */
    SIGNUP_CLINIC_ID: z.uuid().optional(),

    /**
     * Let a new staff member create their own account with "Continue with Google".
     *
     * OFF BY DEFAULT. The account is created with NO roles and therefore no access: it can
     * sign in and see a waiting page, and nothing else, until an administrator assigns a
     * role on the Staff screen. That is what keeps one-account-per-human and
     * least-privilege (§164.312(a)(2)(i), §164.502(b)) an administrator's decision rather
     * than the visitor's.
     *
     * Google only, never a password form. Google has already proven the person controls the
     * address; a password sign-up cannot, and would let anyone register as any colleague.
     */
    STAFF_SELF_SIGNUP: booleanish.default(false),

    /**
     * Let a new patient create a portal account with "Continue with Google".
     *
     * OFF BY DEFAULT. Always creates a NEW patient record — it never looks for an existing
     * one, because nothing a sign-up form can collect proves identity, and attaching a
     * stranger to someone's chart on a name and date of birth is how portals leak records.
     *
     * Google only, for a reason specific to patients: a password sign-up form must say
     * something when an address is already registered, and "already registered" at a
     * medical practice means "is a patient here". Only an emailed confirmation link avoids
     * that, and email needs a vendor with a Business Associate Agreement, which this
     * project does not have yet. With Google, only the owner of the address ever sees the
     * answer.
     */
    PORTAL_SELF_SIGNUP: booleanish.default(false),

    /**
     * Let people create an account with an email address and a password, from a
     * "Create an account" page.
     *
     * OFF BY DEFAULT, one switch per audience, and weaker than the Google path in two ways
     * that this application cannot fix without sending email — which needs a vendor with a
     * Business Associate Agreement, and there is none yet:
     *
     *   The address is not proven. Anyone can type anyone's email. So a password sign-up
     *   grants nothing on its own (staff: no roles; patients: a new, unverified record), it
     *   never signs the person in, and Google sign-in refuses to link itself to such an
     *   account by email — otherwise someone could register a victim's address, wait for the
     *   victim to "Continue with Google", and share the account with them.
     *
     *   It can reveal that an address already has an account. The form answers every
     *   submission identically and never says "already registered", but a person who then
     *   cannot sign in with the password they just chose has learned the address was taken.
     *   For PATIENTS that means learning someone is a patient here, which is health
     *   information. Sign-in rate limits and account lockout slow that down; they do not
     *   remove it. The Google path has neither weakness.
     */
    STAFF_PASSWORD_SIGNUP: booleanish.default(false),
    PORTAL_PASSWORD_SIGNUP: booleanish.default(false),
  })
  /* --- Configuration coherence, every environment -------------------------- */
  .superRefine((env, ctx) => {
    if (env.TRIAGE_ENGINE === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when TRIAGE_ENGINE=openai.',
      });
    }

    /*
     * Both halves or neither. A client id with no secret is a half-configured flow that
     * renders a button and fails at the token exchange, which looks like an outage rather
     * than a misconfiguration.
     */
    /*
     * Offering patients a button that cannot work is worse than not offering it: the
     * patient has already decided to accept the disclosure by the time it fails.
     */
    if (env.PORTAL_GOOGLE_SIGN_IN && !env.GOOGLE_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['PORTAL_GOOGLE_SIGN_IN'],
        message:
          'PORTAL_GOOGLE_SIGN_IN=true requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
    }

    /*
     * GOOGLE_ALLOWED_HD and PORTAL_GOOGLE_SIGN_IN MAY be combined, and in production usually
     * should be: staff limited to the clinic's Workspace, patients on personal accounts.
     * An earlier version refused the combination on the belief that the domain check applied
     * to both flows. It never did — `portalGoogleConfig` always passes no hosted domain, and
     * the portal callback never reads the `hd` claim — so the rule only blocked the correct
     * production setup. The guarantee lives in that code, and a security invariant pins it.
     */

    if (env.STAFF_SELF_SIGNUP && !env.GOOGLE_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['STAFF_SELF_SIGNUP'],
        message: 'STAFF_SELF_SIGNUP=true requires Google sign-in (GOOGLE_CLIENT_ID).',
      });
    }

    if (env.PORTAL_SELF_SIGNUP && !env.PORTAL_GOOGLE_SIGN_IN) {
      ctx.addIssue({
        code: 'custom',
        path: ['PORTAL_SELF_SIGNUP'],
        message: 'PORTAL_SELF_SIGNUP=true requires PORTAL_GOOGLE_SIGN_IN=true.',
      });
    }

    if (
      (env.STAFF_SELF_SIGNUP ||
        env.PORTAL_SELF_SIGNUP ||
        env.STAFF_PASSWORD_SIGNUP ||
        env.PORTAL_PASSWORD_SIGNUP) &&
      !env.SIGNUP_CLINIC_ID
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNUP_CLINIC_ID'],
        message:
          'Self-registration is on but SIGNUP_CLINIC_ID is not set: nothing says which ' +
          'clinic a new account should join.',
      });
    }

    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_SECRET'],
        message:
          'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or both left unset.',
      });
    }

    /*
     * Deliberately NOT production-only. A staging deployment pointed at a free-tier key
     * is still sending somebody's symptoms to a vendor that trains on them, and staging
     * is where real data most often leaks in.
     */
    if (env.TRIAGE_ENGINE === 'openai' && !env.TRIAGE_THIRD_PARTY_BAA_ACKNOWLEDGED) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRIAGE_THIRD_PARTY_BAA_ACKNOWLEDGED'],
        message:
          'TRIAGE_ENGINE=openai discloses patient symptom text to a third party. Set ' +
          'TRIAGE_THIRD_PARTY_BAA_ACKNOWLEDGED=true only when a BAA covers the vendor — ' +
          'OpenAI does not offer one on the free tier.',
      });
    }
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

    /*
     * The OAuth redirect URI is derived from APP_URL and must match what is registered
     * with Google exactly. Deriving it from request headers instead is how a host-header
     * injection turns into an authorization code delivered to somebody else's domain.
     */
    if (env.GOOGLE_CLIENT_ID && !env.APP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL is required when Google sign-in is configured.',
      });
    }

    /*
     * In production, staff self-registration must be narrowed to the clinic's own Google
     * Workspace. Without it anyone on the internet with a Gmail address can file a request
     * that lands in front of an administrator, looking like a colleague, one click from a
     * role. The account grants nothing on its own; the request is still a social-engineering
     * opportunity that the domain check removes.
     */
    if (env.STAFF_SELF_SIGNUP && !env.GOOGLE_ALLOWED_HD) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_ALLOWED_HD'],
        message: 'STAFF_SELF_SIGNUP in production requires GOOGLE_ALLOWED_HD.',
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
