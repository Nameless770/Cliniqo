# `src/server/` — server-only code

Nothing in this tree may ever be imported by a Client Component. Three mechanisms enforce
that, in increasing order of reliability:

1. **Convention** — the folder name. Weakest; documentation only.
2. **`import 'server-only'`** — at the top of every module that touches the database or a
   secret. Turns a bad import into a _build_ error, not a runtime one.
3. **ESLint `no-restricted-imports`** — `src/components/**` and `src/lib/**` are forbidden
   from importing `@/server/*`, `@/db/*`, `@/env/server`, `drizzle-orm`, or `pg`.

A reviewer can miss a bad import. The linter and the compiler cannot.

## Layout

| Folder         | Holds                                                        | Notes    |
| -------------- | ------------------------------------------------------------ | -------- |
| `auth/`        | Password hashing, session issue/verify/revoke, rate limiting | Phase 2  |
| `data-access/` | **The only code permitted to read patient tables**           | Phase 2  |
| `audit/`       | The audit writer used by `data-access`                       | Phase 2  |
| `services/`    | Business logic composed from `data-access`                   | Phase 3+ |
| `actions/`     | `'use server'` entry points                                  | Phase 2+ |

## The layering rule

```
Server Component / Server Action
        |
        v
    services/          business logic, no raw SQL
        |
        v
   data-access/        authorize -> read -> write audit row, one transaction
        |
        v
     db/client         Drizzle
```

`actions/` never queries the database directly. `services/` never bypasses
`data-access/`. The point is that reading PHI without logging it stops being something a
developer can forget and becomes something the codebase has no path for.

## Why `data-access/` exists

Every function there takes an **actor**, a **target**, and a **purpose**. It checks
authorization, performs the read, and writes the audit row **in the same transaction** —
so a rolled-back operation leaves no phantom audit entry, and a committed read cannot be
unlogged.

Retrofitting this after patient screens exist means revisiting every call site, which is
why it is built before the first row of PHI (see `docs/01-requirements-analysis.md` §7).

## Rules for `actions/`

Every `'use server'` function is a **public HTTP endpoint**. Anyone who can reach the app
can call it with any arguments. Therefore, in this order, at the top of every action:

1. Resolve the session. Reject if absent.
2. Re-check authorization **in the action itself**. Never trust that a layout, a
   middleware, or the caller already checked — per CLAUDE.md rule 2.
3. Validate every input with a zod schema. Arguments arrive from the network.
4. Delegate to a service. No inline SQL.
5. Return a narrow projection — only the fields the UI renders, never a whole row.
