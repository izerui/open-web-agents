export const runtime = "nodejs";

/**
 * 嵌入脚本。企业页面上放一行:
 *   <script src="https://<平台>/api/embed/script" data-token="<服务端签发的令牌>"></script>
 *
 * 脚本只负责把 /embed 页面塞进一个浮层 iframe;令牌由企业服务端签发后写进 data-token,
 * 平台的 API Key 始终留在他们后端。
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  const js = `(function () {
  var el = document.currentScript;
  var token = el && el.getAttribute("data-token");
  if (!token) {
    console.error("[owa] 缺少 data-token —— 请由服务端签发嵌入令牌");
    return;
  }
  var origin = ${JSON.stringify(origin)};
  var open = false;

  var frame = document.createElement("iframe");
  frame.src = origin + "/embed?token=" + encodeURIComponent(token);
  frame.style.cssText =
    "position:fixed;right:20px;bottom:88px;width:380px;height:560px;border:0;border-radius:12px;" +
    "box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:2147483000;display:none;background:#fff";
  frame.setAttribute("title", "AI 智能体");

  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "💬";
  btn.setAttribute("aria-label", "打开 AI 智能体");
  btn.style.cssText =
    "position:fixed;right:20px;bottom:20px;width:56px;height:56px;border:0;border-radius:50%;" +
    "background:#111;color:#fff;font-size:24px;cursor:pointer;z-index:2147483001;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.24)";
  btn.onclick = function () {
    open = !open;
    frame.style.display = open ? "block" : "none";
    btn.textContent = open ? "×" : "💬";
  };

  document.body.appendChild(frame);
  document.body.appendChild(btn);
})();`;

  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // 脚本无用户数据,可缓存;令牌在 data-token 上,不进脚本体
      "Cache-Control": "public, max-age=300",
    },
  });
}
