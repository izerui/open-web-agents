import { EmbedChat } from "@/features/embed/embed-chat";

export const dynamic = "force-dynamic";

/**
 * 可嵌入的对话页。设计成放进 iframe 用 —— 令牌从查询串传入,
 * 页面本身不需要平台登录态,所以能挂在任何第三方站点上。
 */
export default async function EmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <p className="text-sm opacity-60">缺少嵌入令牌 —— 请由你的服务端签发后再加载</p>
      </main>
    );
  }
  return <EmbedChat token={token} />;
}
