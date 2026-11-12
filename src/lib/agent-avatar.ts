/**
 * 智能体头像:一个圆形色块加两只眼睛(coze-v3「对话搭建」的智能体身份)。
 *
 * 【为什么按 id 算】市场、会话、工作室、构建页处处要认出同一个智能体,
 * 而大多数智能体从没设置过头像 —— 由 id 稳定地算出颜色与眼睛,任何地方都长一样。
 * 用户在「名称与头像」里改过之后,写回配置的 `icon` 字段(格式见 formatAvatarIcon),以它为准。
 */
export type AvatarEyes = "pill" | "round" | "side" | "dot" | "white";
export type AvatarStyle = { color: string; eyes: AvatarEyes };

export const AVATAR_COLORS: readonly string[] = [
  "#F2B49B",
  "#C8C2E8",
  "#E7D2AA",
  "#CADBCF",
  "#B9D0E8",
  "#F4B3C3",
  "#E3C59D",
  "#C9DDBD",
  "#DAD3C4",
  "#B8DCD6",
  "#F0D58C",
];

/** 白眼只给智能体设计器,其他智能体从这四种里分 */
const EYES: readonly AvatarEyes[] = ["pill", "round", "side", "dot"];
const ARCHITECT: AvatarStyle = { color: "#1F1E1C", eyes: "white" };
const ICON = /^avatar:(#[0-9A-Fa-f]{6}):(pill|round|side|dot|white)$/;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarStyle(id: string, icon?: string | null): AvatarStyle {
  const m = icon ? ICON.exec(icon) : null;
  if (m?.[1] && m[2]) return { color: m[1], eyes: m[2] as AvatarEyes };
  if (id === "agent-architect") return ARCHITECT;
  const h = hash(id);
  return {
    color: AVATAR_COLORS[h % AVATAR_COLORS.length] ?? "#DDD7CA",
    eyes: EYES[Math.floor(h / AVATAR_COLORS.length) % EYES.length] ?? "dot",
  };
}

export function formatAvatarIcon(style: AvatarStyle): string {
  return `avatar:${style.color}:${style.eyes}`;
}
