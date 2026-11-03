import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  appType: 'mpa',
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true, open: '/rehearsal.html',
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../design-system', import.meta.url))] },
  },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:5173', changeOrigin: true,
      configure: proxy => { proxy.on('proxyReq', proxyReq => proxyReq.setHeader('origin', 'http://127.0.0.1:5173')); } } } },
  build: {
    outDir: 'dist-rehearsal',
    rolldownOptions: { input: fileURLToPath(new URL('rehearsal.html', import.meta.url)) },
  },
});
