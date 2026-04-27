import react from '@vitejs/plugin-react'
import wide from 'vite-plugin-wide-range'
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    exclude: ['example-dep']
  },
  plugins: [react(), wide()]
})
