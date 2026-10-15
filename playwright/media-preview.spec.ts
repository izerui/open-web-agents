// 视频/PDF/音频预览浏览器验收

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

const fixtures = { mp4: "", pdf: "", wav: "" };

test.beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-media-fixtures-"));

  fixtures.mp4 = path.join(dir, "test.mp4");
  try {
    execSync(
      `ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:d=3" -f lavfi -i "sine=frequency=440:duration=3" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k "${fixtures.mp4}"`,
      { stdio: "pipe" },
    );
  } catch {
    fixtures.mp4 = "";
  }

  fixtures.pdf = path.join(dir, "test.pdf");
  const content = "BT /F1 24 Tf 72 720 Td (OWA Preview Test) Tj ET";
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n",
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
    `5 0 obj<</Length ${content.length}>>stream\n${content}\nendstream\nendobj\n`,
  ];
  const objOffsets: number[] = [];
  let pos = header.length;
  for (const obj of objects) {
    objOffsets.push(pos);
    pos += obj.length;
  }
  const body = header + objects.join("");
  const xrefPos = body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (const o of objOffsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  fs.writeFileSync(fixtures.pdf, body + xref);

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
    wavBuf.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000),
      44 + i * 2,
    );
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
  const sess = await ctx.request.post(`${BASE}/api/sessions`, { data: { agentId } });
  return ((await sess.json()) as { session: { id: string } }).session.id;
}

async function uploadBuffer(ctx: BrowserContext, sessionId: string, buffer: Buffer, name: string) {
  const res = await ctx.request.post(`${BASE}/api/sessions/${sessionId}/files`, {
    multipart: { files: { name, mimeType: "application/octet-stream", buffer } },
  });
  expect(res.ok(), `上传 ${name} 失败: ${res.status()}`).toBeTruthy();
}

test.describe("视频/PDF/音频预览", () => {
  test("视频: 播放→跳转→从跳转位置继续", async ({ page, context }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用");
    await register(context, "vid-seek");
    const sessionId = await createSession(context);
    await uploadBuffer(context, sessionId, fs.readFileSync(fixtures.mp4), "seek-test.mp4");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("seek-test.mp4")).toBeVisible({ timeout: 15_000 });
    await page.getByText("seek-test.mp4").click();

    const video = page.locator("video");
    await expect(video).toBeVisible({ timeout: 5_000 });

    // duration 有效
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v && v.readyState >= 1 && v.duration > 0;
      },
      { timeout: 10_000 },
    );
    const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
    expect(duration).toBeGreaterThanOrEqual(2);

    // 播放并等 currentTime 增长
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await page.waitForFunction(
      () => document.querySelector("video")!.currentTime > 0.3,
      { timeout: 10_000 },
    );
    await video.evaluate((v: HTMLVideoElement) => v.pause());

    // 跳转到 2 秒并等 seeked 事件
    await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<void>((resolve) => {
          v.addEventListener("seeked", () => resolve(), { once: true });
          v.currentTime = 2;
        }),
    );
    const seekedTime = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(seekedTime).toBeGreaterThanOrEqual(1.5);

    // 从跳转位置继续播放
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await page.waitForFunction(
      () => document.querySelector("video")!.currentTime > 2.2,
      { timeout: 10_000 },
    );
    const timeAfterResume = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(timeAfterResume).toBeGreaterThan(2.1);
  });

  test("PDF: 视觉回归确认页面文字渲染", async ({ page, context }) => {
    await register(context, "pdf-render");
    const sessionId = await createSession(context);
    await uploadBuffer(context, sessionId, fs.readFileSync(fixtures.pdf), "render-test.pdf");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("render-test.pdf")).toBeVisible({ timeout: 15_000 });
    await page.getByText("render-test.pdf").click();

    const pdfFrame = page.locator('iframe[title*="render-test.pdf"]');
    await expect(pdfFrame).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(3000);

    // 只截取包含文字的顶部区域（约 60px 高），文字消失就会超出容差
    const box = await pdfFrame.boundingBox();
    expect(box).toBeTruthy();
    await expect(page).toHaveScreenshot("pdf-text-region.png", {
      clip: { x: box!.x, y: box!.y, width: box!.width, height: 60 },
      maxDiffPixels: 100,
    });
  });

  test("PDF 负向验证: 空白 PDF 不能通过文字基准", async ({ page, context }) => {
    await register(context, "pdf-neg");
    const sessionId = await createSession(context);

    // 生成一个没有文字的空白 PDF
    const blankContent = "BT ET";
    const blankHeader = "%PDF-1.4\n";
    const blankObjs = [
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
      "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n",
      `4 0 obj<</Length ${blankContent.length}>>stream\n${blankContent}\nendstream\nendobj\n`,
    ];
    const blankObjOffsets: number[] = [];
    let bpos = blankHeader.length;
    for (const obj of blankObjs) {
      blankObjOffsets.push(bpos);
      bpos += obj.length;
    }
    const blankBody = blankHeader + blankObjs.join("");
    const blankXrefPos = blankBody.length;
    let blankXref = "xref\n0 5\n0000000000 65535 f \n";
    for (const o of blankObjOffsets) blankXref += `${String(o).padStart(10, "0")} 00000 n \n`;
    blankXref += `trailer<</Size 5/Root 1 0 R>>\nstartxref\n${blankXrefPos}\n%%EOF\n`;
    const blankPdf = Buffer.from(blankBody + blankXref);

    await uploadBuffer(context, sessionId, blankPdf, "blank-test.pdf");
    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("blank-test.pdf")).toBeVisible({ timeout: 15_000 });
    await page.getByText("blank-test.pdf").click();

    const pdfFrame = page.locator('iframe[title*="blank-test.pdf"]');
    await expect(pdfFrame).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(3000);

    const box = await pdfFrame.boundingBox();
    expect(box).toBeTruthy();
    // 空白 PDF 应该无法通过有文字的基准
    await expect(
      expect(page).toHaveScreenshot("pdf-text-region.png", {
        clip: { x: box!.x, y: box!.y, width: box!.width, height: 60 },
        maxDiffPixels: 100,
        timeout: 3_000,
      }),
    ).rejects.toThrow();
  });

  test("音频: duration 有效", async ({ page, context }) => {
    await register(context, "aud-dur");
    const sessionId = await createSession(context);
    await uploadBuffer(context, sessionId, fs.readFileSync(fixtures.wav), "dur-test.wav");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("dur-test.wav")).toBeVisible({ timeout: 15_000 });
    await page.getByText("dur-test.wav").click();

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

  test("面板下载按钮: 点击下载→字节与原文件一致", async ({ page, context }) => {
    await register(context, "dl-btn");
    const sessionId = await createSession(context);
    const originalPdf = fs.readFileSync(fixtures.pdf);
    await uploadBuffer(context, sessionId, originalPdf, "dl-btn-test.pdf");

    await page.goto(`${BASE}/?session=${sessionId}`);
    await expect(page.getByText("dl-btn-test.pdf")).toBeVisible({ timeout: 15_000 });
    await page.getByText("dl-btn-test.pdf").click();

    // 等预览加载
    const pdfFrame = page.locator('iframe[title*="dl-btn-test.pdf"]');
    await expect(pdfFrame).toBeVisible({ timeout: 5_000 });

    // 点击面板下载按钮并捕获下载
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByLabel("下载文件").click(),
    ]);
    const dlPath = await download.path();
    expect(dlPath).toBeTruthy();
    const downloaded = fs.readFileSync(dlPath!);
    expect(Buffer.compare(downloaded, originalPdf)).toBe(0);
  });

  test("Range 请求: 精确区间", async ({ context }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用");
    await register(context, "range-exact");
    const sessionId = await createSession(context);
    const original = fs.readFileSync(fixtures.mp4);
    await uploadBuffer(context, sessionId, original, "range-exact.mp4");
    const url = `${BASE}/api/sessions/${sessionId}/files?download=range-exact.mp4&inline=1`;

    const res = await context.request.fetch(url, { headers: { Range: "bytes=10-109" } });
    expect(res.status()).toBe(206);
    const body = await res.body();
    expect(body.length).toBe(100);
    expect(Buffer.compare(body, original.subarray(10, 110))).toBe(0);
    expect(res.headers()["content-range"]).toBe(`bytes 10-109/${original.length}`);
  });

  test("Range 请求: 后缀范围 bytes=-500 取末尾", async ({ context }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用");
    await register(context, "range-suffix");
    const sessionId = await createSession(context);
    const original = fs.readFileSync(fixtures.mp4);
    await uploadBuffer(context, sessionId, original, "range-suffix.mp4");
    const url = `${BASE}/api/sessions/${sessionId}/files?download=range-suffix.mp4&inline=1`;

    const res = await context.request.fetch(url, { headers: { Range: "bytes=-500" } });
    expect(res.status()).toBe(206);
    const body = await res.body();
    const expectedStart = Math.max(0, original.length - 500);
    const expectedLen = original.length - expectedStart;
    expect(body.length).toBe(expectedLen);
    expect(Buffer.compare(body, original.subarray(expectedStart))).toBe(0);
    expect(res.headers()["content-range"]).toBe(
      `bytes ${expectedStart}-${original.length - 1}/${original.length}`,
    );
  });

  test("Range 请求: 开放结束 bytes=100-", async ({ context }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用");
    await register(context, "range-open");
    const sessionId = await createSession(context);
    const original = fs.readFileSync(fixtures.mp4);
    await uploadBuffer(context, sessionId, original, "range-open.mp4");
    const url = `${BASE}/api/sessions/${sessionId}/files?download=range-open.mp4&inline=1`;

    const res = await context.request.fetch(url, { headers: { Range: "bytes=100-" } });
    expect(res.status()).toBe(206);
    const body = await res.body();
    expect(body.length).toBe(original.length - 100);
    expect(Buffer.compare(body, original.subarray(100))).toBe(0);
  });

  test("Range 请求: 越界范围返回 416", async ({ context }) => {
    if (!fixtures.mp4) test.skip(true, "ffmpeg 不可用");
    await register(context, "range-416");
    const sessionId = await createSession(context);
    const original = fs.readFileSync(fixtures.mp4);
    await uploadBuffer(context, sessionId, original, "range-416.mp4");
    const url = `${BASE}/api/sessions/${sessionId}/files?download=range-416.mp4&inline=1`;

    // start >= size
    const res = await context.request.fetch(url, {
      headers: { Range: `bytes=${original.length}-` },
    });
    expect(res.status()).toBe(416);
    expect(res.headers()["content-range"]).toBe(`bytes */${original.length}`);

    // bytes=-0 (零后缀)
    const res2 = await context.request.fetch(url, { headers: { Range: "bytes=-0" } });
    expect(res2.status()).toBe(416);
  });

  test("流式分支错误处理: 不存在的视频返回 404", async ({ context }) => {
    await register(context, "stream-404");
    const sessionId = await createSession(context);

    const res = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=nonexistent.mp4&inline=1`,
    );
    expect(res.status()).toBe(404);
  });

  test("流式分支错误处理: 越界路径返回 400", async ({ context }) => {
    await register(context, "stream-400");
    const sessionId = await createSession(context);

    const res = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=../../../etc/passwd.mp4&inline=1`,
    );
    expect(res.status()).toBe(400);
  });
});
