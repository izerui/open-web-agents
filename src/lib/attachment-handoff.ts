/**
 * 跨页面带附件:探索首页「立即使用」建好会话后,把首页选的文件交给对话页输入框。
 *
 * 【为什么放在内存里】首页到对话页是客户端跳转(router.push),模块状态还在;
 * 文件对象放进地址栏或 sessionStorage 都不合适(大小、序列化)。按会话 id 存,
 * 只有打开的正是那个会话时才取走,取走即删;过期(默认 2 分钟)不再给,免得几分钟后
 * 在别处冒出一个旧附件。整页刷新后自然就没了 —— 那时用户可以重新拖进输入框。
 */

const TTL_MS = 2 * 60 * 1000;

let pending: { sessionId: string; files: File[]; at: number } | null = null;

export function handOffAttachments(sessionId: string, files: File[], now = Date.now()): void {
  pending = files.length ? { sessionId, files: [...files], at: now } : null;
}

/** 取走交给这个会话的附件;没有、会话不对或已过期时返回空数组 */
export function takeAttachments(sessionId: string | null, now = Date.now()): File[] {
  if (!pending || !sessionId) return [];
  if (now - pending.at > TTL_MS) {
    pending = null;
    return [];
  }
  if (pending.sessionId !== sessionId) return [];
  const { files } = pending;
  pending = null;
  return files;
}
