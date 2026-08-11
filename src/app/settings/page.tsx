import { redirect } from "next/navigation";

/**
 * /settings 本身不是页面 —— 它被拆成了接入/用量/凭证几项。
 * 落点必须和设置区侧栏的第一项一致(PERSONAL_NAV[0]),否则从这里进去
 * 会看到一个和高亮项对不上的页面。
 */
export default function Page() {
  redirect("/settings/keys");
}
