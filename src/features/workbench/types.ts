import type { AgentEvent } from "@/lib/shared";

export interface SessionSummary {
  id: string;
  assistantId: string;
  workspaceDir: string;
  title?: string;
  createdAt: number;
}

export interface AssistantSummary {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  config: { outputSchema?: Record<string, unknown> };
}

export interface FileNode {
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
  text: string | null;
  truncated: boolean;
}

export interface Turn {
  prompt: string;
  events: AgentEvent[];
  running: boolean;
}
