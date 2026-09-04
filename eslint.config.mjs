import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';
import tseslint from 'typescript-eslint';

/**
 * The rules below marked "BOUNDARY" are not style preferences. They are the mechanical
 * half of the server/client separation: a reviewer can miss a bad import, a linter
 * cannot. The documented folder structure explains the intent; these rules enforce it.
 */
export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'drizzle/**', 'next-env.d.ts', 'scripts/**'],
  },

  ...nextCoreWebVitals,
  ...nextTypeScript,

  /* ---------------------------------------------------------------------- */
  /* Baseline                                                               */
  /* ---------------------------------------------------------------------- */
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',

      /**
       * Floating promises are how an audit-log write gets silently dropped: the read
       * returns, the log insert never awaited, the transaction commits without it.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /**
       * BOUNDARY: console.log is where PHI ends up in log aggregators. warn/error are
       * permitted because operational failures must be visible — the review obligation
       * is that they carry IDs and messages, never record content.
       */
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],

      eqeqeq: ['error', 'always'],
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'No PHI in browser storage (CLAUDE.md rule 1).',
        },
        {
          name: 'sessionStorage',
          message: 'No PHI in browser storage (CLAUDE.md rule 1).',
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- */
  /* BOUNDARY: configuration goes through validation                        */
  /* ---------------------------------------------------------------------- */
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      // Defines the validated env; must read the raw values.
      'src/env/**',
      // Reads NEXT_RUNTIME to decide whether to validate at all — necessarily before
      // validation has run. The one place a raw read is correct.
      'src/instrumentation.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            "Import the validated env instead: `import { env } from '@/env/server'`. " +
            'Reading process.env directly bypasses startup validation and can read an ' +
            'unset secret as undefined.',
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- */
  /* BOUNDARY: client-reachable code cannot import server code              */
  /* ---------------------------------------------------------------------- */
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/db', '@/db/*', '@/server/*', '@/env/server'],
              message:
                'Server-only module. Components and lib/ may be bundled for the browser; ' +
                'importing the database, a service, or server env here risks shipping ' +
                'credentials or patient data to the client. Fetch on the server and pass ' +
                'down only the fields the component renders.',
            },
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'pg'],
              message: 'Database libraries belong in src/db and src/server only.',
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- */
  /* Server actions                                                         */
  /* ---------------------------------------------------------------------- */
  {
    files: ['src/server/actions/**/*.ts'],
    rules: {
      /**
       * Every server action is a public HTTP endpoint. Explicit return types keep an
       * accidental widening — returning a whole patient row instead of a projection —
       * from passing review unnoticed.
       */
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
);
