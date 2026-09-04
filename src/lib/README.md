# `src/lib/` — isomorphic helpers

Pure functions that run identically on server and client: date formatting, string helpers,
validation schemas shared between a server action and a form.

Same restriction as `src/components/` — this code can end up in the browser bundle, so no
database, no secrets, no server env. Enforced by ESLint.

If a helper needs any of those, it belongs in `src/server/`.
