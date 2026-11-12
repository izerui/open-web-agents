import { CredentialsView } from "@/features/settings/credentials-view";
import { getContainer } from "@/lib/container";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  const { providers, ensureModels } = getContainer();
  await ensureModels();
  // 有一个启用、配了 Key 与文本接入的提供者,平台算力就算已配置
  const configured = (await providers.list()).some(
    (p) => p.enabled && p.hasKey && !!p.endpoints.llm,
  );
  return <CredentialsView configured={configured} />;
}
