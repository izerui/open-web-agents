import { redirect } from "next/navigation";
import { legacyRedirect } from "./routes";

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function toSearchParams(searchParams: PageSearchParams): Promise<URLSearchParams> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, item);
  }
  return q;
}

/** 旧地址页面:按 legacyRedirect 的映射跳到新地址(查询串原样带上) */
export async function redirectLegacy(
  pathname: string,
  searchParams: PageSearchParams,
): Promise<never> {
  redirect(legacyRedirect(pathname, await toSearchParams(searchParams)) ?? "/");
}
