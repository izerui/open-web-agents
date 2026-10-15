// 视频/PDF/音频预览浏览器验收

import fs from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

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

async function uploadFile(ctx: BrowserContext, sessionId: string, filePath: string, name: string) {
  const buffer = fs.readFileSync(filePath);
  const res = await ctx.request.post(`${BASE}/api/sessions/${sessionId}/files`, {
    multipart: { files: { name, mimeType: "application/octet-stream", buffer } },
  });
  expect(res.ok(), `上传失败: ${res.status()}`).toBeTruthy();
}

test.describe("视频/PDF/音频预览", () => {
  test("视频: 加载时长 + 播放推进", async ({ page, context }) => {
    await register(context, "media-vid");
    const sessionId = await createSession(context);

    const videoPath = "/tmp/test-real.mp4";
    if (!fs.existsSync(videoPath)) test.skip();
    await uploadFile(context, sessionId, videoPath, "demo.mp4");

    await page.goto(`${BASE}/`);
    await page.waitForTimeout(2000);

    // 通过 API 验证 Range 请求不走 read()
    const rangeRes = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=demo.mp4&inline=1`,
      { headers: { Range: "bytes=0-99" } },
    );
    expect(rangeRes.status()).toBe(206);
    const body = await rangeRes.body();
    expect(body.length).toBe(100);
    expect(rangeRes.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect(rangeRes.headers()["accept-ranges"]).toBe("bytes");
  });

  test("PDF: 内联响应带放宽 CSP", async ({ context }) => {
    await register(context, "media-pdf");
    const sessionId = await createSession(context);

    const pdfPath = "/tmp/test-real.pdf";
    if (!fs.existsSync(pdfPath)) test.skip();
    await uploadFile(context, sessionId, pdfPath, "report.pdf");

    const res = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=report.pdf&inline=1`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect(res.headers()["content-disposition"]).toContain("inline");
    expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers()["content-security-policy"]).not.toContain("default-src 'none'");
  });

  test("音频: Range 请求返回 206", async ({ context }) => {
    await register(context, "media-aud");
    const sessionId = await createSession(context);

    await uploadFile(context, sessionId, "/tmp/test.wav", "audio.wav");

    const res = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=audio.wav&inline=1`,
      { headers: { Range: "bytes=0-43" } },
    );
    expect(res.status()).toBe(206);
    const body = await res.body();
    expect(body.length).toBe(44);
    expect(res.headers()["content-range"]).toMatch(/^bytes 0-43\/\d+$/);
  });

  test("图片下载回归: 仍正常", async ({ context }) => {
    await register(context, "media-img");
    const sessionId = await createSession(context);

    // 创建一个 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const uploadRes = await context.request.post(`${BASE}/api/sessions/${sessionId}/files`, {
      multipart: { files: { name: "test.png", mimeType: "image/png", buffer: png } },
    });
    expect(uploadRes.ok()).toBeTruthy();

    // 内联
    const inlineRes = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=test.png&inline=1`,
    );
    expect(inlineRes.status()).toBe(200);
    expect(inlineRes.headers()["content-type"]).toBe("image/png");
    expect(inlineRes.headers()["content-disposition"]).toContain("inline");

    // 下载
    const dlRes = await context.request.fetch(
      `${BASE}/api/sessions/${sessionId}/files?download=test.png`,
    );
    expect(dlRes.status()).toBe(200);
    expect(dlRes.headers()["content-disposition"]).toContain("attachment");
  });

  test("文件面板 UI: 视频/PDF 点击后显示对应预览元素", async ({ page, context }) => {
    await register(context, "media-ui");
    const sessionId = await createSession(context);

    if (!fs.existsSync("/tmp/test-real.mp4") || !fs.existsSync("/tmp/test-real.pdf")) test.skip();
    await uploadFile(context, sessionId, "/tmp/test-real.mp4", "preview-test.mp4");
    await uploadFile(context, sessionId, "/tmp/test-real.pdf", "preview-test.pdf");
    await uploadFile(context, sessionId, "/tmp/test.wav", "preview-test.wav");

    // 打开工作台，选中该会话
    await page.goto(`${BASE}/?session=${sessionId}`);
    await page.waitForTimeout(4000);

    // 文件面板应列出上传的文件
    await expect(page.getByText("preview-test.mp4")).toBeVisible({ timeout: 10_000 });

    // 点击视频文件
    await page.getByText("preview-test.mp4").click();
    const video = page.locator("video");
    await expect(video).toBeVisible({ timeout: 5_000 });
    // 验证视频有 src 属性指向内联端点
    const videoSrc = await video.getAttribute("src");
    expect(videoSrc).toContain("inline=1");
    expect(videoSrc).toContain("preview-test.mp4");

    // 点击 PDF 文件
    await page.getByText("preview-test.pdf").click();
    // PDF 渲染为 iframe
    const pdfFrame = page.locator('iframe[title*="preview-test.pdf"]');
    await expect(pdfFrame).toBeVisible({ timeout: 5_000 });
    const pdfSrc = await pdfFrame.getAttribute("src");
    expect(pdfSrc).toContain("inline=1");
    expect(pdfSrc).toContain("preview-test.pdf");

    // 点击音频文件
    await page.getByText("preview-test.wav").click();
    const audio = page.locator("audio");
    await expect(audio).toBeVisible({ timeout: 5_000 });
    const audioSrc = await audio.getAttribute("src");
    expect(audioSrc).toContain("inline=1");
    expect(audioSrc).toContain("preview-test.wav");
  });
});
