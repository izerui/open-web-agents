import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/utils";

/**
 * 首页与登录页的一排头像:七种颜色和眼睛,第五个是智能体设计器(黑底白眼)。
 * 白眼只许设计器用,所以那一位按设计器的 id 渲染、不传 icon(传了会被丢掉,退回米色)。
 */
const FACES: { id: string; icon?: string }[] = [
  { id: "face-0", icon: "avatar:#F2B49B:pill" },
  { id: "face-1", icon: "avatar:#C8C2E8:round" },
  { id: "face-2", icon: "avatar:#E7D2AA:side" },
  { id: "face-3", icon: "avatar:#CADBCF:pill" },
  { id: "agent-architect" },
  { id: "face-5", icon: "avatar:#F4B3C3:round" },
  { id: "face-6", icon: "avatar:#B9D0E8:dot" },
];

export function AvatarRow({
  size,
  ringClassName = "ring-background",
  avatarClassName,
  className,
}: {
  size: number;
  /** 窄屏缩小用(CSS 宽高覆盖 svg 的 width/height 属性) */
  avatarClassName?: string;
  /** 头像之间的描边色与所在底色一致,看起来像叠在一起 */
  ringClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex", className)} aria-hidden="true">
      {FACES.map(({ id, icon }, i) => (
        <span key={id} className={cn("rounded-full ring-[3px]", ringClassName, i > 0 && "-ml-2.5")}>
          <AgentAvatar id={id} icon={icon} size={size} className={cn("block", avatarClassName)} />
        </span>
      ))}
    </div>
  );
}
