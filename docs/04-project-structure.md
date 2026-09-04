# Cliniqo — Project Structure

Where code lives, and specifically where the server/client boundary sits.

---

## Tree

```
cliniqo/
├─ drizzle/                     migration SQL + journal (generated, then hand-edited)
├─ docs/                        analysis, data model, ops, this file
├─ scripts/                     migrate.js, wait-for-db.js   (plain Node, no build step)
├─ src/
│  ├─ app/                      App Router. Routing only — no business logic.
│  │  ├─ layout.tsx             root layout (Server Component, stays one)
│  │  ├─ page.tsx               "/" → redirect to /login
│  │  ├─ globals.css
│  │  ├─ (auth)/                route group: unauthenticated
│  │  │  ├─ layout.tsx
│  │  │  └─ login/page.tsx
│  │  ├─ (staff)/               route group: authenticated. Session check lives here.
│  │  │  ├─ layout.tsx
│  │  │  └─ dashboard/page.tsx
│  │  └─ api/health/route.ts    liveness probe (the one legitimate route handler so far)
│  │
│  ├─ db/                       ── SERVER ONLY ──
│  │  ├─ client.ts              pg Pool + Drizzle, lazily constructed
│  │  └─ schema/                one module per domain + shared enums/types
│  │
│  ├─ server/                   ── SERVER ONLY ──
│  │  ├─ auth/                  passwords, sessions, rate limiting     (phase 2)
│  │  ├─ data-access/           the ONLY code allowed to read patient tables (phase 2)
│  │  ├─ audit/                 audit writer used by data-access       (phase 2)
│  │  ├─ services/              business logic                          (phase 3+)
│  │  └─ actions/               'use server' entry points               (phase 2+)
│  │
│  ├─ env/
│  │  ├─ server.ts              ── SERVER ONLY ── validated secrets
│  │  └─ client.ts              NEXT_PUBLIC_* only. Public forever.
│  │
│  ├─ components/               ── MAY REACH THE BROWSER ──
│  │  └─ ui/                    generic primitives, no domain knowledge
│  │
│  ├─ lib/                      ── MAY REACH THE BROWSER ── pure isomorphic helpers
│  └─ instrumentation.ts        runs once at server start → env validation
│
├─ docker-compose.yml           local Postgres only
├─ drizzle.config.ts  next.config.ts  eslint.config.mjs  .prettierrc.json
└─ .env.example                 every variable, documented
```

---

## The boundary, and how it is enforced

The rule is one sentence: **`src/db`, `src/server`, and `src/env/server.ts` may never be
reached from code that ships to the browser.**

Four mechanisms hold it, weakest to strongest:

**1. Convention.** Folder names. Documentation only — worth nothing on its own.

**2. `import 'server-only'`.** At the top of `db/client.ts` and `env/server.ts`. If a
Client Component imports either, transitively, the **build fails**. Not a runtime error, a
build error — it cannot reach production.

**3. ESLint `no-restricted-imports`.** `src/components/**` and `src/lib/**` are blocked
from importing `@/db/*`, `@/server/*`, `@/env/server`, `drizzle-orm`, or `pg`. Verified:

```
src/components/ui/probe.tsx
  2:1  error  '@/db/client' import is restricted from being used by a pattern...
  3:1  error  '@/env/server' import is restricted from being used by a pattern...
```

**4. Server Components by default.** Nothing in `app/` carries `'use client'` unless
interactivity demands it, and no layout does. Marking a layout `'use client'` would push
every page beneath it toward the client boundary.

### The subtler leak that none of the above catches

A **Server** Component can fetch a full patient row and pass it as a prop to a Client
Component. That serialises every column into the HTML payload — including columns the
current role is not permitted to see. Conditional rendering does not help: the data is
already in the page source, visible in view-source.

So the rule for `components/`: **pass the fields the component renders, never the record.**
A receptionist's patient card receives a name and a phone number, not a patient object with
the clinical columns still attached. This is minimum-necessary (§164.502(b)) expressed as a
prop type, and it is the one part of the boundary that only code review catches.

---

## Layering inside `src/server/`

```
Server Component  /  Server Action  ('use server')
        │
        ▼
    services/          business logic, no raw SQL
        │
        ▼
   data-access/        authorize → read → write audit row, one transaction
        │
        ▼
    db/client          Drizzle
```

`actions/` never queries the database directly. `services/` never bypasses `data-access/`.

`data-access/` is the load-bearing layer: every function takes an **actor**, a **target**,
and a **purpose**; it checks authorization, performs the read, and writes the audit row in
the same transaction. Reading PHI without logging it stops being something a developer can
forget and becomes something the codebase has no path for.

### Rules for every server action

A `'use server'` function is a **public HTTP endpoint**. Anyone who can reach the app can
call it with any arguments. So, in this order:

1. Resolve the session; reject if absent.
2. Re-check authorization **in the action itself**. The `(staff)` layout guard is UX and
   defence in depth, never the access-control boundary — CLAUDE.md rule 2.
3. Validate every input with a zod schema.
4. Delegate to a service. No inline SQL.
5. Return a narrow projection.

---

## Route groups

`(auth)` and `(staff)` are parenthesised, so they do **not** appear in URLs — `/login`, not
`/auth/login`. The grouping exists so the session check has exactly one home: `(staff)/layout.tsx`.

Adding an authenticated page means putting it under `(staff)/`, and it inherits the guard.
Putting it elsewhere is the mistake the structure is shaped to make visible.

---

## Configuration

`src/env/server.ts` validates at startup via `src/instrumentation.ts`, which Next runs once
per server process before the first request.

**`getEnv()` is a function, not a constant.** `next build` imports route modules to collect
page data; a module-scope `const env = parse(process.env)` would run then, and a build must
not require a database URL or a production secret. Same reason `getDb()` is a function — the
pool is constructed on first real use.

**`APP_ENV`, not `NODE_ENV`, gates the production invariants.** `next build` forces
`NODE_ENV=production` wherever it runs, so keying TLS-required and https-required checks off
it would break every local and CI build. That pressure is precisely how a
`rejectUnauthorized: false` gets committed to make a build pass. `APP_ENV` is set by the
operator and means what it says.

Verified behaviour:

```
$ APP_ENV=production npx next start
Failed to prepare server Error: Invalid environment configuration:
  - APP_URL: APP_URL must use https in production.
  - DATABASE_SSL: DATABASE_SSL=disable is not permitted in production.

$ SESSION_SECRET=short npx next start
Failed to prepare server Error: Invalid environment configuration:
  - SESSION_SECRET: SESSION_SECRET must be at least 32 characters
```

Errors name the variable and never echo its value — startup errors reach log aggregators,
terminals, and screenshots.

`process.env` is banned by ESLint everywhere except `src/env/**` and
`src/instrumentation.ts` (which must read `NEXT_RUNTIME` before validation can run).

---

## npm scripts

| Script                    | Does                                                     |
| ------------------------- | -------------------------------------------------------- |
| `dev`                     | `next dev`                                               |
| `build` / `start`         | production build / serve                                 |
| `lint` / `lint:fix`       | ESLint (Next 16 removed `next lint`; this is standalone) |
| `format` / `format:check` | Prettier                                                 |
| `typecheck`               | `tsc --noEmit`                                           |
| `db:generate`             | new migration from schema changes                        |
| `db:migrate`              | apply migrations as the **owner** role                   |
| `db:check`                | migration journal consistency                            |
| `db:setup`                | migrate + set the local `cliniqo_app` password           |
| `db:reset`                | destroy the local volume and rebuild                     |
| `db:studio`               | Drizzle Studio                                           |
| `verify`                  | typecheck + lint + db:check — the CI gate                |

---

## Open decision: styling

No CSS framework is installed. `globals.css` carries a token baseline and component styles
go in CSS Modules until a decision is made.

This is deliberate rather than unfinished: CLAUDE.md requires asking before adding a
dependency, and a styling system is a large one to reverse. Tailwind is the obvious
candidate when UI work starts and the brand identity is designed. Say the word.
