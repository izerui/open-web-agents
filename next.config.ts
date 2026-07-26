import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // claude-agent-sdk 会 spawn 子进程,必须留在 Node 运行时、不被打包器改写
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
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
