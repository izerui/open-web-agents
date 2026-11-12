import { type PageSearchParams, redirectLegacy } from "@/lib/nav/legacy-page";

/** 旧地址,已迁到 /account/billing(见 src/lib/nav/routes.ts) */
export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  return redirectLegacy("/settings/billing", searchParams);
}
