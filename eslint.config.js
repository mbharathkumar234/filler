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
    // Phase 8 tightens this into a full module-boundary rule; the boundary is declared
    // here from Phase 0 so it can never be crossed by accident in between.
    files: ['src/background/redaction.ts', 'src/background/llm-client.ts'],
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
