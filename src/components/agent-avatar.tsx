import { type AvatarEyes, avatarStyle } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";

const INK = "#1B1B1A";

function Eyes({ kind }: { kind: AvatarEyes }) {
  switch (kind) {
    case "pill":
      return (
        <>
          <rect x="13.2" y="13.5" width="4.6" height="10" rx="2.3" fill={INK} />
          <rect x="22.2" y="13.5" width="4.6" height="10" rx="2.3" fill={INK} />
          <circle cx="15" cy="16" r="1" fill="#fff" />
          <circle cx="24" cy="16" r="1" fill="#fff" />
        </>
      );
    case "white":
      return (
        <>
          <rect x="13.2" y="13.5" width="4.4" height="10" rx="2.2" fill="#fff" />
          <rect x="22.4" y="13.5" width="4.4" height="10" rx="2.2" fill="#fff" />
        </>
      );
    case "round":
      return (
        <>
          <circle cx="15" cy="18" r="4.4" fill="#fff" />
          <circle cx="25" cy="18" r="4.4" fill="#fff" />
          <circle cx="16" cy="18.6" r="2.2" fill={INK} />
          <circle cx="26" cy="18.6" r="2.2" fill={INK} />
        </>
      );
    case "side":
      return (
        <>
          <ellipse cx="16" cy="19" rx="2" ry="3.4" fill={INK} />
          <ellipse cx="24" cy="19" rx="2" ry="3.4" fill={INK} />
          <circle cx="16.6" cy="17.6" r=".8" fill="#fff" />
          <circle cx="24.6" cy="17.6" r=".8" fill="#fff" />
        </>
      );
    default:
      return (
        <>
          <circle cx="15.5" cy="19" r="2.1" fill={INK} />
          <circle cx="24.5" cy="19" r="2.1" fill={INK} />
        </>
      );
  }
}

/** 智能体头像。纯展示(aria-hidden):旁边总有名字,读屏不必再念一遍。 */
export function AgentAvatar({
  id,
  icon,
  size = 32,
  className,
}: {
  id: string;
  icon?: string | null;
  size?: number;
  className?: string;
}) {
  const { color, eyes } = avatarStyle(id, icon);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <circle cx="20" cy="20" r="19.5" fill={color} />
      <circle cx="14" cy="11" r="9" fill="#fff" opacity=".16" />
      <circle cx="20" cy="20" r="19" fill="none" stroke="rgba(0,0,0,.08)" />
      <Eyes kind={eyes} />
    </svg>
  );
}
