import { redirect } from "next/navigation";

/** 智能体是核心功能不是设置项,已提到 /assistants。旧地址保留跳转。 */
export default function Page() {
  redirect("/assistants");
}
