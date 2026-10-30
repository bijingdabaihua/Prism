import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/app',
  // 资产（模型 / 贴图 / 环境图 / 画廊封面）原样发布到站点根目录
  publicDir: '../../assets',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: '../../dist/app',
    // 输出目录在项目根之外（dist/app），vite 默认不敢清空，旧 chunk 会一直堆着
    emptyOutDir: true,
  },
});
