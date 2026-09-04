# `src/components/` — presentational components

May be bundled for the browser. Treat everything here as **public code running on an
untrusted machine**.

- No database access, no server env, no secrets. ESLint blocks those imports.
- Receive data as props, already narrowed by a server component or service.
- A component should receive the _fields it renders_, not a whole patient record. Passing
  a full row to a Client Component serialises every column into the HTML payload —
  including the ones the current role is not allowed to see. That is a minimum-necessary
  violation that no amount of conditional rendering fixes, because the data is already in
  the page source.

`ui/` holds generic, domain-free primitives (button, field, table). Domain components that
know what a patient is live beside their route, not here.
