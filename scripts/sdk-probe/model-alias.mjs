// 别名 → 真实模型 id:SDK 发给网关的 model 字段是否跟随 ANTHROPIC_DEFAULT_<别名>_MODEL。
// 判据看假网关收到的请求体里的 model。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const { query } = await import("@anthropic-ai/claude-agent-sdk");
async function modelSent(alias, extraEnv) {
  const gw = await startFakeGateway([{ text: "ok" }]);
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
  for await (const _ of query({
    prompt: "hi",
    options: {
      cwd: wsDir,
      model: alias,
      maxTurns: 1,
      settingSources: [],
      env: { ...isolatedEnv(gw.baseUrl, cfgDir), ...extraEnv },
    },
  })) {
  }
  gw.close();
  return gw.seenRequests.map((r) => r?.model).filter(Boolean);
}
const pins = {
  ANTHROPIC_DEFAULT_FABLE_MODEL: "pinned-fable",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "pinned-opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "pinned-sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "pinned-haiku",
};
for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
  console.log(`${alias.padEnd(6)} 固定后:`, (await modelSent(alias, pins)).join(","));
}
const { ANTHROPIC_DEFAULT_FABLE_MODEL: _, ...noFable } = pins;
console.log("fable  未固定 fable 槽:", (await modelSent("fable", noFable)).join(","));
