import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactCompiler: true,
  // claude-agent-sdk 会 spawn 子进程,必须留在 Node 运行时、不被打包器改写
  // pdfjs-dist(知识库上传 PDF 提取文字):worker 与 CMap / 标准字体数据按路径在运行时读取,
  // 打包器改写后找不到;CMap 缺了,未嵌入字体的中文 PDF 提取出来是空的
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "pdfjs-dist"],
  // standalone 只带被追踪到的文件:pdf.js 运行时按路径读取的这些要显式带上
  outputFileTracingIncludes: {
    "/api/agents/[id]/knowledge/upload": [
      "./node_modules/pdfjs-dist/package.json",
      "./node_modules/pdfjs-dist/legacy/build/**",
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/standard_fonts/**",
    ],
  },
  // 容器镜像用 standalone:只打包实际用到的依赖,镜像小很多
  output: "standalone",
  // 上层目录存在其它 lockfile,显式钉住工作区根,避免 Turbopack 推断到 $HOME
  turbopack: { root: projectRoot },

  async headers() {
    return [
      {
        // /embed 就是给第三方站点 iframe 用的,必须允许跨站嵌入。
        // 其余页面不放开 —— 避免平台工作台被套进钓鱼页面(clickjacking)。
        source: "/embed",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
      {
        source: "/((?!embed).*)",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default nextConfig;
