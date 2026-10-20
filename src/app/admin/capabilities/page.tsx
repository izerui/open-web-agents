import { redirect } from "next/navigation";

/** 旧地址:模型管理已改为按提供者维护 */
export default function Page() {
  redirect("/admin/providers");
}
