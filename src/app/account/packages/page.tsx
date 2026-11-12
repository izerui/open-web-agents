import { type PageSearchParams, redirectLegacy } from "@/lib/nav/legacy-page";

/** 充值与订单已并入「积分与套餐」的页签 /account/billing?tab=packages(见 src/lib/nav/routes.ts) */
export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  return redirectLegacy("/account/packages", searchParams);
}
