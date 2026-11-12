"use client";

/**
 * 根布局崩溃时的最后一道兜底。
 *
 * 【为什么不能复用 error.tsx】error.tsx 渲染在根布局【内部】——
 * 如果崩的正是根布局本身,它根本没有机会挂载。所以这个文件必须自带
 * <html> 与 <body>,并且不能依赖任何在根布局里注入的东西(主题类、字体变量、
 * TooltipProvider 都没有),样式只能内联写死。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          background: "#F7F6F2",
          color: "#1B1B1A",
          fontFamily: "system-ui, -apple-system, 'PingFang SC', sans-serif",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>应用启动失败</h1>
        <p style={{ fontSize: "0.875rem", color: "#6B6860", margin: 0, maxWidth: "32rem" }}>
          数据没有丢失。请重试,若持续失败请把下面的编号提供给维护者。
        </p>
        <code
          style={{
            fontSize: "0.75rem",
            color: "#6B6860",
            border: "1px solid #E6E3DB",
            borderRadius: "0.375rem",
            padding: "0.375rem 0.625rem",
          }}
        >
          {error.digest ?? error.message.slice(0, 120) ?? "unknown"}
        </code>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "0.25rem",
            cursor: "pointer",
            border: "none",
            borderRadius: "999px",
            background: "#1C1C1C",
            color: "#ffffff",
            fontSize: "0.875rem",
            fontWeight: 500,
            padding: "0.5rem 1rem",
          }}
        >
          重试
        </button>
      </body>
    </html>
  );
}
