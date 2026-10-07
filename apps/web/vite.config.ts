import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Workspace packages ship TypeScript source; Vite transpiles them like local files.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/v1': 'http://127.0.0.1:3001' } },
});
