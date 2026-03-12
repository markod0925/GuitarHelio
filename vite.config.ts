import { defineConfig } from 'vite';
import { createSongImportApiPlugin } from './src/server/songImportApi';

export default defineConfig({
  plugins: [createSongImportApiPlugin()],
  server: { host: '0.0.0.0', port: 5173 }
});
