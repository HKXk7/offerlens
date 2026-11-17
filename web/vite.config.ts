import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api 代理到 Node 后端（8787），生产时由后端直接托管 dist。
export default defineConfig({
  plugins: [react()],
  resolve: {
    // 本项目在工作区里是通过软链挂载的（C:\...\WorkBuddy → D:\Apps\WorkBuddy）。
    // 保留符号链接，避免 rollup 在打包 HTML 入口时把路径解析成真实路径后报
    // "fileName must be neither absolute nor relative"。这样软链路径与真实路径下都能构建。
    preserveSymlinks: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
