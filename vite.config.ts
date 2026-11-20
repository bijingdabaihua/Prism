import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  // 资产（模型 / 贴图 / 环境图 / 画廊封面）原样发布到站点根目录
  publicDir: '../assets',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: '../dist/app',
    // 输出目录在项目根之外（dist/app），vite 默认不敢清空，旧 chunk 会一直堆着
    emptyOutDir: true,
  },
  // 渲染 Worker 和主线程共用 core / engine 模块，会拆出共享 chunk ——
  // 只支持 ES 格式（默认的 iife 不能 code-split）
  worker: {
    format: 'es',
  },
});
