import { redirect } from "next/navigation";

/** 用量拆成了「我的用量」与「全平台用量」,旧地址落到个人的那个。 */
export default function Page() {
  redirect("/settings/usage");
}
