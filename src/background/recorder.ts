import {
  MAX_RECORDED_REQUESTS,
  RECORD_PING_MESSAGE,
  RECORD_STATE_MESSAGE,
  isRawRequestRecord,
  sanitizeRecord,
  type RecordedRequest,
  type RecordingSample,
  type RecordingStatus,
  type RecordingTabs,
} from "../boss/recording";

/**
 * 上传接口录制的 Service Worker 侧：状态与脱敏后的记录放在 chrome.storage.session，
 * 浏览器关闭即清空；Service Worker 被回收后重启也能接着录。原始记录只在内存里经过 sanitizeRecord。
 */

const STATE_KEY = "record:state";
const ITEMS_KEY = "record:items";
/** 两个内容脚本的打包产物路径（相对扩展根目录）。 */
const CAPTURE_FILE = "content/networkCapture.js";
const BRIDGE_FILE = "content/captureBridge.js";
/** 探活超时：某个标签卡住时，不能把记录追加一起拖死。 */
const PING_TIMEOUT_MS = 1200;
/** 探活结果缓存，弹窗每秒轮询时不必每次真的去 ping。 */
const PROBE_TTL_MS = 2_000;

interface StoredState {
  recording: boolean;
  startedAt?: string;
  truncated?: boolean;
}

/** 追加记录与开关操作串行执行，避免并发读改写丢条目。 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function readState(): Promise<{ state: StoredState; items: RecordedRequest[] }> {
  const stored = await chrome.storage.session.get([STATE_KEY, ITEMS_KEY]);
  return {
    state: (stored[STATE_KEY] as StoredState | undefined) ?? { recording: false },
    items: (stored[ITEMS_KEY] as RecordedRequest[] | undefined) ?? [],
  };
}

/** 通知所有 BOSS 标签页的桥接脚本；没注入桥接脚本的标签页会报错，忽略即可。 */
async function broadcast(recording: boolean): Promise<void> {
  const tabs = await bossTabs();
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, { type: RECORD_STATE_MESSAGE, recording }).catch(() => undefined))),
  );
}

async function bossTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: ["https://*.zhipin.com/*"] });
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([task, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

/**
 * 探活：内容脚本收到 ping 会回话。扩展重载后旧的 content script 运行时已失效，
 * 既不转发记录也收不到广播，只有「有没有回话」能区分它到底还活着没有。
 */
async function ping(tabId: number): Promise<boolean> {
  try {
    const reply = await withTimeout(chrome.tabs.sendMessage(tabId, { type: RECORD_PING_MESSAGE }) as Promise<{ ok?: unknown } | undefined>, PING_TIMEOUT_MS);
    return reply?.ok === true;
  } catch {
    // 页面里没有内容脚本接收时 sendMessage 直接 reject，等同于「没接上」。
    return false;
  }
}

/**
 * 把录制脚本重新注入目标标签。
 *
 * 主世界脚本自带安装守卫，重复注入无副作用；隔离世界的桥接脚本必须重装 —— 扩展重载后
 * 旧桥接的 chrome.runtime 已失效（sendMessage 会同步抛错），它自己不干活也收不到广播。
 * 主世界那侧的请求包装仍留在页面里，重装桥接后它 postMessage 出来的记录就能重新被接住。
 */
async function injectRecorder(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CAPTURE_FILE], world: "MAIN" });
  await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] });
}

function labelOf(tab: chrome.tabs.Tab): string {
  if (!tab.url) return `标签 ${tab.id ?? "?"}`;
  try {
    return new URL(tab.url).pathname || "/";
  } catch {
    return tab.url;
  }
}

/** 逐个标签探活，没回话的重新注入，再探一次。返回真实可用的标签数。 */
export async function attachRecorder(): Promise<RecordingTabs> {
  const tabs = await bossTabs();
  const failed: string[] = [];
  let alive = 0;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const label = labelOf(tab);
    try {
      if (!(await ping(tab.id))) await injectRecorder(tab.id);
      if (await ping(tab.id)) alive += 1;
      else failed.push(`${label} 注入后仍无响应，请刷新该页面`);
    } catch (error) {
      failed.push(`${label} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  probeCache = undefined;
  return { matched: tabs.length, alive, failed };
}

let probeCache: { at: number; tabs: RecordingTabs } | undefined;
let probePending: Promise<RecordingTabs> | undefined;

async function probeRecorder(): Promise<RecordingTabs> {
  const tabs = await bossTabs();
  const ids = tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
  const replies = await Promise.all(ids.map((id) => ping(id)));
  // 轮询只报数不报原因：失败详情由 attachRecorder 在真正尝试注入时给出。
  return { matched: tabs.length, alive: replies.filter(Boolean).length, failed: [] };
}

/** 轮询用：只探活不注入（注入是重活，只在开始录制或用户手动重连时做）。 */
function probeStatus(): Promise<RecordingTabs> {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return Promise.resolve(probeCache.tabs);
  if (probePending) return probePending;
  probePending = probeRecorder()
    .then((tabs) => {
      probeCache = { at: Date.now(), tabs };
      return tabs;
    })
    .finally(() => {
      probePending = undefined;
    });
  return probePending;
}

export async function getRecordingStatus(): Promise<RecordingStatus> {
  const { state, items } = await serial(readState);
  return { recording: state.recording, startedAt: state.startedAt, count: items.length, tabs: await probeStatus() };
}

/** 开始录制：清空上一轮记录，并把录制脚本接回已打开的 BOSS 标签（不要求用户刷新页面）。 */
export function startRecording(): Promise<RecordingStatus> {
  return serial(async () => {
    const startedAt = new Date().toISOString();
    await chrome.storage.session.set({ [STATE_KEY]: { recording: true, startedAt } satisfies StoredState, [ITEMS_KEY]: [] });
    // 先注入再广播：新注入的桥接脚本会自己查一次状态，已存在的靠广播切换。
    const tabs = await attachRecorder();
    await broadcast(true);
    return { recording: true, startedAt, count: 0, tabs };
  });
}

/** 结束录制并返回样本；记录随之清空，样本只交给扩展页下载。 */
export function stopRecording(): Promise<RecordingSample | null> {
  return serial(async () => {
    const { state, items } = await readState();
    await chrome.storage.session.remove([STATE_KEY, ITEMS_KEY]);
    probeCache = undefined;
    await broadcast(false);
    // 返回 null 而不是 undefined：扩展页靠 undefined 判断“后台没回应”。
    if (!state.startedAt) return null;
    return {
      kind: "boss-upload-recording",
      version: 1,
      startedAt: state.startedAt,
      stoppedAt: new Date().toISOString(),
      truncated: state.truncated === true,
      requests: items,
    };
  });
}

/** 桥接脚本交来的原始记录：校验结构、脱敏后追加；未在录制时直接丢弃。 */
export function appendRecord(raw: unknown): Promise<void> {
  return serial(async () => {
    if (!isRawRequestRecord(raw)) return;
    const { state, items } = await readState();
    if (!state.recording || !state.startedAt) return;
    const startedAtMs = Date.parse(state.startedAt);
    // 页面加载初期暂存的记录可能早于开始录制，不属于本轮。
    if (raw.at < startedAtMs) return;
    if (items.length >= MAX_RECORDED_REQUESTS) {
      if (!state.truncated) await chrome.storage.session.set({ [STATE_KEY]: { ...state, truncated: true } });
      return;
    }
    const sanitized = sanitizeRecord(raw, startedAtMs);
    if (!sanitized) return;
    await chrome.storage.session.set({ [ITEMS_KEY]: [...items, sanitized] });
  });
}
