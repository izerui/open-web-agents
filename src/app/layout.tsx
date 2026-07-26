import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Web Agents",
  description: "可自定义专用场景的智能体平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
