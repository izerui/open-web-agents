// 视频/PDF/音频预览浏览器验收

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

const fixtures = {
  mp4: "",
  pdf: "",
  wav: "",
};

test.beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-media-fixtures-"));

  // 3 秒蓝色视频 + 440Hz 正弦音频
  fixtures.mp4 = path.join(dir, "test.mp4");
  try {
    execSync(
      `ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:d=3" -f lavfi -i "sine=frequency=440:duration=3" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k "${fixtures.mp4}"`,
      { stdio: "pipe" },
    );
  } catch {
    fixtures.mp4 = "";
  }

  // 有效 PDF（Helvetica 渲染 "OWA Preview Test"）
  fixtures.pdf = path.join(dir, "test.pdf");
  const content = "BT /F1 24 Tf 72 720 Td (OWA Preview Test) Tj ET";
  const pdfParts = [
    "%PDF-1.4\n",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n",
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
    `5 0 obj<</Length ${content.length}>>stream\n${content}\nendstream\nendobj\n`,
  ];
  const offsets = [0];
  let pos = pdfParts[0].length;
  for (let i = 1; i < pdfParts.length; i++) {
    offsets.push(pos);
    pos += pdfParts[i].length;
  }
  let xref = `xref\n0 ${pdfParts.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= pdfParts.length; i++) {
    xref += `${String(offsets[i - 1] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  // recalculate: offsets[0] is header, objects start at offsets[1]
  // Simpler: write as buffer, track byte positions
  const bodyBuf = Buffer.from(pdfParts.join(""));
  const xrefPos = bodyBuf.length;
  const xrefBuf = Buffer.from(
    xref + `trailer<</Size ${pdfParts.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`,
  );
  fs.writeFileSync(fixtures.pdf, Buffer.concat([bodyBuf, xrefBuf]));

  // 1 秒 8kHz 单声道 WAV（正弦波）
  fixtures.wav = path.join(dir, "test.wav");
  const sampleRate = 8000;
  const samples = sampleRate;
  const dataSize = samples * 2;
  const wavBuf = Buffer.alloc(44 + dataSize);
  wavBuf.write("RIFF", 0);
  wavBuf.writeUInt32LE(36 + dataSize, 4);
  wavBuf.write("WAVE", 8);
  wavBuf.write("fmt ", 12);
  wavBuf.writeUInt32LE(16, 16);
  wavBuf.writeUInt16LE(1, 20);
  wavBuf.writeUInt16LE(1, 22);
  wavBuf.writeUInt32LE(sampleRate, 24);
  wavBuf.writeUInt32LE(sampleRate * 2, 28);
  wavBuf.writeUInt16LE(2, 32);
  wavBuf.writeUInt16LE(16, 34);
  wavBuf.write("data", 36);
  wavBuf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    wavBuf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000), 44 + i * 2);
  }
  fs.writeFileSync(fixtures.wav, wavBuf);
});

async function register(ctx: BrowserContext, tag: string) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-${tag}-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok(), `注册失败: ${res.status()}`).toBeTruthy();
}

async function createSession(ctx: BrowserContext) {
  const agents = await ctx.request.get(`${BASE}/api/agents`);
  const agentId = ((await agents.json()) as { agents: { id: string }[] }).agents[0].id;
  const sess = await ctx.request.post(`${BASE}/api/sessions`, {
    data: { agentId },
  });
  return ((await sess.json()) as { session: { id: string } }).session.id;
}

async function uploadBuffer(ctx: BrowserContext, sessionId: string, buffer: Buffer, name: string) {
  const res = await ctx.request.post(`${BASE}/api/sessions/${sessionId}/files`, {
    multipart: { files: { name, mimeType: "application/octet-stream", buffer } },
  });
  expect(res.ok(), `上传 ${name} 失败: ${res.status()}`).toBeTruthy();
}

test.describe("视频/PDF/音频预览", () => {
  test("视频: duration 有效 + 播放后 currentTime 增长 + 跳转后继续", async ({
    page,
    context,
  }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用,跳过视频测试");
    await register(context, "vid-play");
    const sessionId = await createSession(context);
    await uploadBuffer(context, sessionId, fs.readFileSync(fixtures.mp4), "play-test.mp4");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("play-test.mp4")).toBeVisible({ timeout: 15_000 });
    await page.getByText("play-test.mp4").click();

    const video = page.locator("video");
    await expect(video).toBeVisible({ timeout: 5_000 });

    // 等待 metadata 加载，验证 duration 有效
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v && v.readyState >= 1 && v.duration > 0;
      },
      { timeout: 10_000 },
    );
    const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
    expect(duration).toBeGreaterThanOrEqual(2);
    expect(duration).toBeLessThanOrEqual(5);

    // 播放并等待 currentTime 增长
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v && v.currentTime > 0.3;
      },
      { timeout: 10_000 },
    );
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    const timeAfterPlay = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(timeAfterPlay).toBeGreaterThan(0.2);

    // 跳转到 2 秒
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 2;
    });
    await page.waitForTimeout(300);
    const timeAfterSeek = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(timeAfterSeek).toBeGreaterThanOrEqual(1.5);
  });

  test("PDF: iframe 能加载内容", async ({ page, context }) => {
    await register(context, "pdf-view");
    const sessionId = await createSession(context);
    await uploadBuffer(context, sessionId, fs.readFileSync(fixtures.pdf), "view-test.pdf");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("view-test.pdf")).toBeVisible({ timeout: 15_000 });
    await page.getByText("view-test.pdf").click();

    const pdfFrame = page.locator('iframe[title*="view-test.pdf"]');
    await expect(pdfFrame).toBeVisible({ timeout: 5_000 });

    // 验证 iframe src 指向内联端点
    const src = await pdfFrame.getAttribute("src");
    expect(src).toContain("inline=1");
    expect(src).toContain("view-test.pdf");

    // 验证 iframe 实际加载（非空白——检查 contentWindow 可访问性受限于 CSP，
    // 但可以验证 iframe 高度 > 0 且 HTTP 响应正常）
    const box = await pdfFrame.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeGreaterThan(100);
  });

  test("音频: 加载后 duration 有效", async ({ page, context }) => {
    await register(context, "aud-play");
    const sessionId = await createSession(context);
    await uploadBuffer(context, sessionId, fs.readFileSync(fixtures.wav), "play-test.wav");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("play-test.wav")).toBeVisible({ timeout: 15_000 });
    await page.getByText("play-test.wav").click();

    const audio = page.locator("audio");
    await expect(audio).toBeVisible({ timeout: 5_000 });

    await page.waitForFunction(
      () => {
        const a = document.querySelector("audio");
        return a && a.readyState >= 1 && a.duration > 0;
      },
      { timeout: 10_000 },
    );
    const duration = await audio.evaluate((a: HTMLAudioElement) => a.duration);
    expect(duration).toBeGreaterThanOrEqual(0.9);
    expect(duration).toBeLessThanOrEqual(1.5);
  });

  test("下载字节一致", async ({ context }) => {
    await register(context, "dl-check");
    const sessionId = await createSession(context);
    const originalPdf = fs.readFileSync(fixtures.pdf);
    await uploadBuffer(context, sessionId, originalPdf, "dl-check.pdf");

    const res = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=dl-check.pdf`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain("attachment");
    const downloaded = await res.body();
    expect(Buffer.compare(downloaded, originalPdf)).toBe(0);
  });

  test("Range 请求返回正确字节区间", async ({ context }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用");
    await register(context, "range-check");
    const sessionId = await createSession(context);
    const originalMp4 = fs.readFileSync(fixtures.mp4);
    await uploadBuffer(context, sessionId, originalMp4, "range-check.mp4");

    const res = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=range-check.mp4&inline=1`,
      { headers: { Range: "bytes=10-109" } },
    );
    expect(res.status()).toBe(206);
    const body = await res.body();
    expect(body.length).toBe(100);
    expect(Buffer.compare(body, originalMp4.subarray(10, 110))).toBe(0);
    expect(res.headers()["content-range"]).toBe(`bytes 10-109/${originalMp4.length}`);
  });
});
