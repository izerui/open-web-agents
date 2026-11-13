/**
 * 跨页面带附件:探索首页「立即使用」建好会话后,当场把首页选的文件传进这个会话的工作区,
 * 再把文件名交给对话页 —— 输入框附件条里显示「已在工作区」的附件,发第一条消息时拼进附件清单,不再重复上传。
 *
 * 【为什么用 sessionStorage 存文件名】文件已经在服务端了,交接的只是几个文件名;
 * 存在本标签页的 sessionStorage 里,整页刷新后附件条还在,换标签页不会串到别处。
 * 按会话 id 分开存;发送成功后由对话页清掉。
 */

type HandoffStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

const keyOf = (sessionId: string) => `owa.handoff.${sessionId}`;

function defaultStorage(): HandoffStorage {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // 隐私模式等禁用了存储
    return null;
  }
}

/** 记下已经传进这个会话工作区的附件(空列表等于清空) */
export function handOffUploaded(
  sessionId: string,
  names: readonly string[],
  storage: HandoffStorage = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (names.length) storage.setItem(keyOf(sessionId), JSON.stringify(names));
    else storage.removeItem(keyOf(sessionId));
  } catch {
    // 存储满或被禁用:附件仍在工作区,只是附件条里不显示
  }
}

/** 交给这个会话、还没随消息发出的附件文件名 */
export function handedOffFiles(
  sessionId: string | null,
  storage: HandoffStorage = defaultStorage(),
): string[] {
  if (!sessionId || !storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(keyOf(sessionId)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** 附件已随消息发出(或用户移除了全部)后清掉 */
export function clearHandedOff(
  sessionId: string,
  storage: HandoffStorage = defaultStorage(),
): void {
  try {
    storage?.removeItem(keyOf(sessionId));
  } catch {
    // 忽略
  }
}
