export interface FileNode {
  /** 相对工作空间根的路径,用 / 分隔。 */
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface FilePreview {
  path: string;
  mime: string;
  size: number;
  /** 文本内容;二进制或过大时为 null,由前端走下载。 */
  text: string | null;
  truncated: boolean;
}

export interface StoragePort {
  /** 列出工作空间下某目录的直接子项。 */
  tree(workspaceDir: string, relDir: string): Promise<FileNode[]>;
  /** 读取用于预览(文本截断,二进制不回内容)。 */
  preview(workspaceDir: string, relPath: string): Promise<FilePreview>;
  /** 读原始字节用于下载。 */
  read(workspaceDir: string, relPath: string): Promise<{ bytes: Buffer; mime: string }>;
}
