/**
 * 在 BOSS 页面隔离世界 document_start 注入（manifest content_scripts，默认 ISOLATED）。
 *
 * 连接主世界的 content/networkCapture.ts 与 Service Worker：
 * - 把扩展的录制开关告知主世界（每次页面加载主动查询一次，之后跟随 Service Worker 广播）；
 * - 只在录制开启时把主世界交来的请求记录转给 Service Worker。记录在 Service Worker 里逐字段校验并脱敏。
 *
 * 网页脚本能看到并伪造 window.postMessage，因此这里只认自身窗口的消息，录制关闭时一律丢弃。
 * 本文件不能有运行时 import：它以普通脚本形式注入。消息类型字面量与 boss/recording.ts 保持一致。
 */
export {};

const CHANNEL = "__bossResumeExt__";
const STATUS_MESSAGE = "boss.record.status";
const STATE_MESSAGE = "boss.record.state";
const APPEND_MESSAGE = "boss.record.append";
const PING_MESSAGE = "boss.record.ping";

let recording = false;

function publish(value: boolean): void {
  recording = value;
  window.postMessage({ [CHANNEL]: "state", recording: value }, location.origin);
}

try {
  chrome.runtime
    .sendMessage({ type: STATUS_MESSAGE })
    .then((status: { recording?: unknown } | undefined) => publish(status?.recording === true))
    .catch(() => publish(false));
} catch {
  // 扩展重载后旧脚本的运行时已失效，sendMessage 会同步抛错。此时不自行恢复（做不到），
  // 由 Service Worker 重新注入一份完整的桥接脚本来接管，见 background/recorder.ts 的 attachRecorder。
  publish(false);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const data = message as { type?: unknown; recording?: unknown } | null;
  // 探活：Service Worker 靠这个才知道本页面还能不能录。
  if (data?.type === PING_MESSAGE) {
    sendResponse({ ok: true, recording });
    return;
  }
  if (data?.type === STATE_MESSAGE && typeof data.recording === "boolean") publish(data.recording);
});

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || !recording) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data[CHANNEL] !== "record") return;
  try {
    void chrome.runtime.sendMessage({ type: APPEND_MESSAGE, record: data.record }).catch(() => undefined);
  } catch {
    // 运行时已失效（扩展重载），本条记录丢弃；重新注入后由新脚本继续转发。
  }
});
