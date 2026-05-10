import { defineConfig } from 'vite'

export default defineConfig({
  base: './',           // rutas relativas para deploy estático
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1000
  },
  server: {
    port: 3000,
    open: true          // abre el browser automáticamente
  }
})