import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // claude-agent-sdk 会 spawn 子进程,必须留在 Node 运行时、不被打包器改写
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // 上层目录存在其它 lockfile,显式钉住工作区根,避免 Turbopack 推断到 $HOME
  turbopack: { root: projectRoot },
};

export default nextConfig;
