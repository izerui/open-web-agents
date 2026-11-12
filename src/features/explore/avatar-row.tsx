import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/utils";

/** 首页与登录页的一排头像:七种颜色和眼睛,中间是智能体设计器。 */
const FACES = [
  "avatar:#F2B49B:pill",
  "avatar:#C8C2E8:round",
  "avatar:#E7D2AA:side",
  "avatar:#CADBCF:pill",
  "avatar:#1F1E1C:white",
  "avatar:#F4B3C3:round",
  "avatar:#B9D0E8:dot",
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
      {FACES.map((icon, i) => (
        <span
          key={icon}
          className={cn("rounded-full ring-[3px]", ringClassName, i > 0 && "-ml-2.5")}
        >
          <AgentAvatar
            id={`face-${i}`}
            icon={icon}
            size={size}
            className={cn("block", avatarClassName)}
          />
        </span>
      ))}
    </div>
  );
}
