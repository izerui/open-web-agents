"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * 全站提示(取舍 6):底部居中的深色胶囊,宽度随文字(原型 #toast)。
 * 放在右上角时会盖住右侧抽屉的标题和关闭按钮,手机上会盖住页面标题。
 *
 * 用 unstyled 自己画:sonner 默认样式是固定 356px 宽的白卡片。
 * 定位仍交给 sonner(绝对定位 + 堆叠动画),这里只用 inset-x-0 + mx-auto + w-fit 让胶囊居中收窄 ——
 * 不能用 translate 居中,sonner 的进出场动画占用了 transform。
 * 手机上底部有标签栏(约 64px),提示抬到它上面。
 */
function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-center"
      offset={{ bottom: "28px" }}
      mobileOffset={{ bottom: "calc(env(safe-area-inset-bottom) + 80px)", left: "16px", right: "16px" }}
      gap={8}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "inset-x-0 mx-auto flex w-fit max-w-[min(560px,calc(100vw-32px))] items-center gap-2 rounded-[22px] bg-[#1C1C1C] px-[18px] py-2.5 text-sm leading-snug text-white shadow-[0_8px_24px_rgb(28_28_28/22%)]",
          content: "min-w-0 flex flex-col gap-0.5",
          title: "font-normal break-words",
          description: "text-[13px] text-white/75 break-words",
          icon: "flex size-4 shrink-0 items-center justify-center",
          success: "[&_[data-icon]]:text-[#9FD8B0]",
          error: "[&_[data-icon]]:text-[#F4A898]",
          warning: "[&_[data-icon]]:text-[#F2CF8A]",
          info: "[&_[data-icon]]:text-white/80",
          actionButton:
            "ml-1 shrink-0 rounded-full bg-white/15 px-3 py-1 text-[13px] font-medium text-white hover:bg-white/25",
          cancelButton:
            "ml-1 shrink-0 rounded-full px-3 py-1 text-[13px] text-white/75 hover:bg-white/10",
        },
      }}
    />
  );
}

export { Toaster };
