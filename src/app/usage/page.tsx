import { type PageSearchParams, redirectLegacy } from "@/lib/nav/legacy-page";

/** 旧地址(见 src/lib/nav/routes.ts 的 legacyRedirect) */
export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  return redirectLegacy("/usage", searchParams);
}
