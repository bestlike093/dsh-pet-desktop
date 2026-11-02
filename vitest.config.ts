import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@pet/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url)
      )
    }
  },
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/desktop/src/**/*.test.ts',
      'apps/desktop/electron/**/*.test.mjs'
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node'
  }
})
