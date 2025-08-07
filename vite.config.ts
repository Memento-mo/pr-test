import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import lightningcss from 'vite-plugin-lightningcss'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), lightningcss({
    drafts: {
      customMedia: true
    }
  })],
})
