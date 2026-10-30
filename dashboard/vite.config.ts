import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    // The page imports ../client from the repo root.
    fs: { allow: ['..'] }
  }
})
