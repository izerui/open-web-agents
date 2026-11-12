"use client";

import { requestClientNavigation } from "@/lib/client-navigation";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { clearMe } from "@/lib/use-me";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";

/** 登出:头像菜单与手机「我的」页共用。同一时刻只发一次;有未保存的改动时先问(requestClientNavigation)。 */
export function useLogout(): () => Promise<void> {
  const router = useRouter();
  const loggingOutRef = useRef(false);
  return async function logout() {
    if (loggingOutRef.current || !requestClientNavigation("/login", true)) return;
    loggingOutRef.current = true;
    try {
      await fetchJson("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      clearMe();
      toast.success("已登出");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      toast.error(`登出失败：${errorText(error)}`);
    } finally {
      loggingOutRef.current = false;
    }
  };
}
