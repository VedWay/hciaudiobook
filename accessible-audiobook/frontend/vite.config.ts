/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API key holders live in the backend; the browser only ever talks to /api.
    proxy: { '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true } },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
})
