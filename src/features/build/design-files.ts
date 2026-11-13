// 设计器附件上传(构建页设计器输入框、探索首页「用设计器创建」共用)。

/** 把附件传进设计会话的工作区,返回实际的文件名 */
export async function uploadDesignFiles(sessionId: string, files: File[]): Promise<string[]> {
  if (!files.length) return [];
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(`/api/agents/design/${encodeURIComponent(sessionId)}/files`, {
    method: "POST",
    body: form,
  });
  const body = (await res.json().catch(() => null)) as { files?: string[]; error?: string } | null;
  if (!res.ok || !body?.files)
    throw new Error(`上传附件失败：${body?.error ?? `HTTP ${res.status}`}`);
  return body.files;
}
