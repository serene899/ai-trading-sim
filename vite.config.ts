/// <reference types="vitest" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// 主屏幕版：纯静态部署到 GitHub Pages 子路径，与钱在哪/生息/阅迹同做法（相对路径 base）。
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'AI 自动交易 · 模拟',
        short_name: 'AI交易',
        description: '个人 AI 辅助模拟交易系统：只模拟、不接真实资金。数据只存在本机，行情来自 OKX 公共接口。',
        lang: 'zh-CN',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0e13',
        theme_color: '#0b0e13',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,webmanifest}'], // 不预缓存 png 图标：图标文件经网页端补传前可能 404，不能让它拖垮 SW 安装
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // 行情接口绝不走缓存：OKX 请求直连网络
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    // 单文件打包：全部 JS 合成一个文件。2026-11-25 真机（iOS 27.3 beta）出现
    // 「顶栏正常、页面主体空白」——分开的路由懒加载 chunk 在其设备上未能加载，
    // 而主包本身正常。合成单文件后没有独立 chunk 可丢，规避该类问题。
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
    chunkSizeWarningLimit: 4096,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5306,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4306,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
