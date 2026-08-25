import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Build output of the e2e derivation harness — generated, not authored.
      'fixtures/_harness/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side tooling: build config, the fixtures server, test harness scripts.
    // Scripts that drive a browser (page.evaluate) need browser globals too.
    files: ['*.config.{js,ts}', 'scripts/**/*.{js,mjs,ts}', 'tests/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Extension code runs in a browser/service-worker context, not Node.
    files: ['src/**/*.{ts,tsx}', 'tests/e2e/harness/*.ts'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-globals': ['error', { name: 'eval', message: 'No eval (§ Phase 10 CSP).' }],
    },
  },
  {
    // P3 / CLAUDE.md rule 2: the LLM egress path must not be able to reach user data.
    //
    // Phase 8 note: `value-guard.ts` is deliberately NOT on this list. It is the
    // one module that must see the user's own values — to check that the page is
    // not echoing them back at the model — and it can only subtract. Everything
    // downstream of it (llm-client) stays on the list, so a value cannot travel
    // any further than the check that removes it.
    files: [
      'src/background/redaction.ts',
      'src/background/llm-client.ts',
      // Phase 8: the response validator and merge rules sit on the same path.
      // They handle model output, which is untrusted input, and there is no
      // reason for either to reach a value.
      'src/matching/llm-matcher.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/vault/*', '@/documents/*', '../vault/*', '../documents/*'],
              message:
                'P3: the LLM egress path must not import vault or document code. Payloads are built from FieldDescriptors only.',
            },
          ],
        },
      ],
    },
  },
);
