// 导入 Node.js 路径模块与 Vite 配置定义函数
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 获取当前模块所在目录的绝对路径
const rootDir = fileURLToPath(new URL('.', import.meta.url));

// 导出 Vite 构建配置
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        // 主看板页面
        main: resolve(rootDir, 'index.html')
      }
    }
  }
});
