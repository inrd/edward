import {defineConfig} from 'vite';

export default defineConfig({
  base: './',
  build: {
    sourcemap: true,
    lib: {
      entry: './src/index.js',
      formats: ['es'],
      fileName: 'index'
    },
    rollupOptions: {
      external: (id) => id === 'ol' || id.startsWith('ol/')
    }
  }
});
