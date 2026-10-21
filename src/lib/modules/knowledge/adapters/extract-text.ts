// 上传到知识库的文件 → 纯文本。只存提取出的文字,不存原文件。
//
// 解析本身在独立的子进程里跑(extract-child.mjs),这里只负责起进程、计时、到点杀掉:
// 【时限必须真的停下解析】解压与在大 XML 上跑正则都是同步重活,放在 web 进程里,计时器在它跑完之前
// 根本触发不了;pdf.js 超时后也不会自己停。子进程到点 SIGKILL,解析真正结束,web 进程照常响应。
// 【内存上限也必须隔离】worker_threads 的 resourceLimits 在大块分配时会把整个进程判成内存耗尽
// (实测主线程跟着崩),所以用独立进程 + --max-old-space-size:爆内存只死子进程。
// 【都有上限】文件大小、PDF 页数、解压后的总大小(防 zip 炸弹)、解析时长、子进程内存、同时解析的个数。

import { fork } from "node:child_process";
import path from "node:path";

export interface ExtractLimits {
  maxBytes: number;
  maxPdfPages: number;
  /** zip 里要读的那些 XML 解压后合计的上限 */
  maxUnzippedBytes: number;
  /** 解析时长上限:到点杀掉子进程 */
  timeoutMs: number;
  /** 子进程的堆上限(MB):超了子进程自己退出,不影响 web 进程 */
  maxHeapMb: number;
}

export const EXTRACT_LIMITS: ExtractLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPdfPages: 500,
  maxUnzippedBytes: 100 * 1024 * 1024,
  timeoutMs: 60_000,
  maxHeapMb: 512,
};

export type ExtractResult =
  | { ok: true; text: string; format: "pdf" | "docx" | "pptx" | "xlsx" | "text"; pages?: number }
  | { ok: false; reason: string };

/** 同时最多几个文件在解析:每个子进程占一个 CPU 核,不能被并发上传占满 */
const MAX_PARALLEL = 2;

/**
 * 子进程入口,按路径加载、不经打包。以进程工作目录为基准:开发与测试时是仓库根;
 * 生产镜像里是 /app —— Dockerfile 运行层本来就把完整的 src 与 node_modules 拷进去
 * (worker 入口与迁移脚本也靠它),子进程脚本和它用的 fflate、pdfjs-dist(含 CMap 数据)都在。
 * 不用 import.meta.url:打包器会改写它,得不到源文件的真实位置
 */
const CHILD_PATH = ["src", "lib", "modules", "knowledge", "adapters", "extract-child.mjs"];
/** 运行时拼出路径:打包器若能静态推出这个路径,会试图把子进程脚本一起打包(构建时实测报错) */
const childFile = () => path.join(process.cwd(), ...CHILD_PATH.map((s) => s));

let running = 0;
const waiting: (() => void)[] = [];
let alive = 0;

/** 当前还活着的解析子进程数(测试用:确认超时后子进程确实退出) */
export function liveExtractionWorkers(): number {
  return alive;
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

type Format = Extract<ExtractResult, { ok: true }>["format"];
type ChildReply =
  | { ok: true; format: Format; text: string; pages?: number }
  | { ok: false; rejected: boolean; reason: string };
type RunOutcome = ChildReply | { ok: false; timeout: true } | { ok: false; crashed: string };

function runChild(fileName: string, bytes: Uint8Array, limits: ExtractLimits): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = fork(childFile(), [], {
      execArgv: [`--max-old-space-size=${limits.maxHeapMb}`],
      // 子进程不需要平台的环境变量(数据库地址、密钥等);PATH 之类也用不到
      env: { NODE_ENV: process.env.NODE_ENV, OWA_EXTRACT_CHILD: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    alive++;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let settled = false;
    const finish = (r: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
      // 结果已拿到或已超时:无论如何都把子进程收掉
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => finish({ ok: false, timeout: true }), limits.timeoutMs);
    child.once("message", (m) => finish(m as ChildReply));
    child.once("error", (err) => finish({ ok: false, crashed: err.message }));
    // close 在输出流读完之后才触发(exit 时错误输出可能还没读到):据此判断是不是内存耗尽。
    // V8 内存耗尽时进程以 SIGABRT 结束;我们自己杀的是 SIGKILL,那时结果早已定下
    child.once("close", (_code, signal) => {
      alive--;
      const oom = /heap out of memory|Reached heap limit/i.test(stderr) || signal === "SIGABRT";
      finish({ ok: false, crashed: oom ? "oom" : "解析进程意外退出" });
    });
    child.send({
      fileName,
      bytes,
      limits: { maxPdfPages: limits.maxPdfPages, maxUnzippedBytes: limits.maxUnzippedBytes },
    });
  });
}

export async function extractText(
  fileName: string,
  bytes: Uint8Array,
  limits: ExtractLimits = EXTRACT_LIMITS,
): Promise<ExtractResult> {
  if (bytes.length === 0) return { ok: false, reason: "文件是空的" };
  if (bytes.length > limits.maxBytes) {
    return { ok: false, reason: `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 上限` };
  }
  const r = await slot(() => runChild(fileName, bytes, limits));
  if ("timeout" in r) {
    return {
      ok: false,
      reason: `解析超过 ${Math.round(limits.timeoutMs / 1000)} 秒,文件可能过于复杂,已停止解析`,
    };
  }
  if ("crashed" in r) {
    return {
      ok: false,
      reason:
        r.crashed === "oom"
          ? "文件内容过大或过于复杂,解析时超出内存上限,已停止解析"
          : `无法读取文件内容:${r.crashed}`,
    };
  }
  if (!r.ok) {
    return {
      ok: false,
      reason: r.rejected ? r.reason : `无法读取文件内容(可能已损坏):${r.reason}`,
    };
  }
  const text = tidy(r.text);
  if (!text) {
    return {
      ok: false,
      reason:
        r.format === "pdf"
          ? "PDF 里没有可提取的文字(可能是扫描件或图片),需要先做文字识别再上传"
          : "文件里没有可提取的文字",
    };
  }
  return { ok: true, format: r.format, text, ...(r.pages !== undefined ? { pages: r.pages } : {}) };
}

/** 去掉 BOM、统一换行、行尾空白,连续空行压成一个 */
function tidy(s: string): string {
  return s
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
