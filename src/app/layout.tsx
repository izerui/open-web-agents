import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/*
 * 字体随仓库分发(src/app/fonts,SIL OFL 1.1,许可证同目录),不再在构建时从 Google Fonts 拉取。
 *
 * 【为什么】next/font/google 会在构建时联网下载字体,网络一抖整个构建就失败 ——
 * 实际遇到过连续多次因连不上 fonts.gstatic.com 而构建失败。本地文件让构建不依赖外网。
 * 文件是 Google Fonts 提供的拉丁子集可变字重 woff2,与原先 subsets: ["latin"] 的产物相同;
 * 中文仍按 CSS 里的字体栈回落到系统字体。
 */
// 变量名会成为 @font-face 的字体族名:用具体的名字,别用 sans / mono 这类过于通用的名字
const interTight = localFont({
  src: "./fonts/InterTight-Variable-latin.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
});

// 会话 ID、文件名、代码预览大量使用等宽字体,不定义就会落到浏览器默认值
const jetbrainsMono = localFont({
  src: "./fonts/JetBrainsMono-Variable-latin.woff2",
  weight: "100 800",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Open Web Agents",
  description: "可自定义专用场景的智能体平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      className={`dark ${interTight.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
