// SDK 把 cwd 编码成 projects 子目录名的真实规则。
// 用含各种字符的工作目录(以及经符号链接到达的目录)各跑一次,看盘上实际的目录名。
// 结论写进 domain/transcript-path.ts 的 projectDirNameFor。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const gw = await startFakeGateway([]);
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owa-enc-")));
const cases = ["a_b", "sp ace", "plus+at@", "中文目录", "tilde~x", "dot.dir", "MiXeD-09"];
const linkTarget = path.join(root, "real-target");
fs.mkdirSync(linkTarget);
fs.symlinkSync(linkTarget, path.join(root, "via-link"));

for (const name of [...cases, "via-link"]) {
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd, { recursive: true });
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
  for await (const _ of query({
    prompt: "hi",
    options: { cwd, maxTurns: 1, settingSources: [], env: isolatedEnv(gw.baseUrl, cfgDir) },
  })) {
  }
  const dirs = fs.readdirSync(path.join(cfgDir, "projects"));
  console.log(
    JSON.stringify({
      cwd: cwd.slice(root.length),
      dir: dirs[0]?.slice(dirs[0].indexOf("owa-enc-")),
    }),
  );
}
console.log("root:", root);
gw.close();
