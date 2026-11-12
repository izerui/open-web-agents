import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-[#D9D5CB] disabled:pointer-events-none aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        /* 近黑胶囊:每屏最多一个的主操作 */
        default:
          "bg-primary text-primary-foreground hover:bg-black disabled:bg-[#E3E0D8] disabled:text-[#57544D]",
        /* 白底红字:危险操作不用整块红,避免和主操作抢 */
        destructive:
          "border border-[#E7C9C0] bg-card text-destructive hover:bg-destructive-soft disabled:text-muted-foreground disabled:opacity-60",
        outline:
          "border border-border bg-card text-foreground hover:bg-[#F2F0EA] disabled:text-muted-foreground disabled:opacity-60",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[#E3E0D8] disabled:text-muted-foreground disabled:opacity-60",
        success:
          "bg-success text-white hover:bg-success-text disabled:bg-[#E3E0D8] disabled:text-[#57544D]",
        ghost:
          "text-[#4D4A43] hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
        link: "rounded-none text-foreground underline decoration-[#C9C4B8] underline-offset-[3px] hover:decoration-foreground",
      },
      size: {
        default: "h-10 px-[18px] has-[>svg]:px-4",
        xs: "h-7 gap-1 px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-3.5 text-[13px] has-[>svg]:px-3",
        lg: "h-11 px-6 has-[>svg]:px-5",
        icon: "size-10",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
