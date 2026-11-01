import { installCvApiInPage } from "../boss/cvPageApi";
import { cvResumeTaskInPage } from "../boss/pageFetch";
import { uploadResumeInPage } from "../boss/pageUpload";
import { onlineResumeReadInPage } from "../boss/online/pageRead";
import { onlineDictInPage, type OnlineDictTrees } from "../boss/online/pageDict";
import { onlineResumeWriteInPage } from "../boss/online/pageWrite";
import {
  ONLINE_DICT_MESSAGE,
  ONLINE_READ_MESSAGE,
  ONLINE_WRITE_MESSAGE,
  type OnlineOperation,
  type OnlineReadOutcome,
  type OnlineWriteResult,
} from "../boss/online/types";
import { BOSS_FETCH_MESSAGE, BOSS_LIST_MESSAGE, type BossFetchError, type BossPageOutcome } from "../boss/types";
import { BOSS_UPLOAD_MESSAGE, type BossUploadResult, type UploadPlan } from "../boss/uploadPlan";
import { RECORD_APPEND_MESSAGE, RECORD_ATTACH_MESSAGE, RECORD_START_MESSAGE, RECORD_STATUS_MESSAGE, RECORD_STOP_MESSAGE } from "../boss/recording";
import { appendRecord, attachRecorder, getRecordingStatus, startRecording, stopRecording } from "./recorder";

const editorUrl = chrome.runtime.getURL("index.html");
const extensionOrigin = new URL(editorUrl).origin;

/** 在哪个 BOSS 页面里执行注入脚本。读取与上传都复用同一套「找标签页 → 注入 → 执行」流程。 */
interface PageTarget {
  /** 临时打开时用的地址。 */
  url: string;
  /** 落地地址的 host 校验：未登录会被跳到登录页，host 不对就是没登录。 */
  host: string;
  /** 复用已打开标签时匹配的 URL 模式。 */
  patterns: string[];
  /** 报错里告诉用户该手动打开哪个地址。 */
  hint: string;
}

/** 直聘简历（可建多份简历）。读取、上传都在这个页面里调用它自己的接口。 */
const CV_TARGET: PageTarget = {
  url: "https://cv.zhipin.com/my-resumes/",
  host: "cv.zhipin.com",
  patterns: ["https://cv.zhipin.com/*"],
  hint: "cv.zhipin.com/my-resumes/",
};

/** 在线简历（求职者主简历）。读取走 /wapi/zpgeek/resume/geek/preview/data.json。 */
const GEEK_TARGET: PageTarget = {
  url: "https://www.zhipin.com/web/geek/resume",
  host: "www.zhipin.com",
  patterns: ["https://www.zhipin.com/*"],
  hint: "www.zhipin.com/web/geek/resume",
};

const TAB_LOAD_TIMEOUT_MS = 15_000;

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: editorUrl });
});

function waitForTabComplete(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("直聘简历页加载超时"));
    }, TAB_LOAD_TIMEOUT_MS);
    const finish = (tab: chrome.tabs.Tab) => {
      cleanup();
      resolve(tab);
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete" && tab.url && tab.url !== "about:blank") finish(tab);
    };
    const onRemoved = (id: number) => {
      if (id !== tabId) return;
      cleanup();
      reject(new Error("直聘简历页被关闭"));
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 监听注册前页面可能已加载完成；新标签初始的 about:blank 带 pendingUrl，需排除。
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete" && !tab.pendingUrl && tab.url && tab.url !== "about:blank") finish(tab);
      })
      .catch(() => undefined);
  });
}

/** 已加载完成的 BOSS 标签，当前激活的优先，其余按最近访问排序。 */
async function findPageTab(patterns: string[]): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ url: patterns });
  return tabs
    .filter((tab) => tab.id !== undefined && !tab.discarded && tab.status === "complete")
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]?.id;
}

class CvPageError extends Error {
  public constructor(public readonly info: BossFetchError) {
    super(info.message);
  }
}

/**
 * 在 BOSS 页面的主世界里执行 func：先装请求工具，再执行任务。
 * reuseOpenTab 为 true 时优先用已打开的同域标签；否则后台临时打开 target.url，执行完关闭。
 */
async function runInPage<A extends unknown[], R>(target: PageTarget, func: (...args: A) => Promise<R>, args: A, reuseOpenTab: boolean): Promise<R> {
  let tabId = reuseOpenTab ? await findPageTab(target.patterns) : undefined;
  let temporary: number | undefined;
  try {
    if (tabId === undefined) {
      const tab = await chrome.tabs.create({ url: target.url, active: false }).catch((error: unknown) => {
        throw new CvPageError({ code: "NO_TAB", message: `无法打开 BOSS 页面，请手动打开 ${target.hint} 后重试`, detail: String(error) });
      });
      if (tab.id === undefined) throw new CvPageError({ code: "NO_TAB", message: "无法打开 BOSS 页面" });
      tabId = temporary = tab.id;
      const loaded = await waitForTabComplete(tabId).catch((error: unknown) => {
        throw new CvPageError({ code: "NO_TAB", message: "BOSS 页面没有打开成功，请稍后重试", detail: error instanceof Error ? error.message : String(error) });
      });
      // 未登录时会被跳到登录页等其他地址。
      const landed = loaded.url ? new URL(loaded.url) : undefined;
      if (!landed || landed.hostname !== target.host) {
        throw new CvPageError({ code: "NOT_LOGGED_IN", message: "BOSS 登录状态无效，请在浏览器中登录求职者账号后重试", detail: loaded.url });
      }
    }
    let result: unknown;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: installCvApiInPage });
      // args 必须可序列化：undefined 会让 executeScript 报 Value is unserializable，先经 JSON 往返清掉。
      const safeArgs = JSON.parse(JSON.stringify(args)) as A;
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args: safeArgs });
      result = injection?.result;
    } catch (error) {
      throw new CvPageError({
        code: "PAGE_UNAVAILABLE",
        message: "无法在直聘简历页中执行，请刷新直聘简历页后重试",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (result === undefined) throw new CvPageError({ code: "PAGE_UNAVAILABLE", message: "直聘简历页没有返回结果，请刷新后重试" });
    return result as R;
  } finally {
    if (temporary !== undefined) await chrome.tabs.remove(temporary).catch(() => undefined);
  }
}

async function readCv(task: "list" | "detail", cvId?: string): Promise<BossPageOutcome<unknown>> {
  try {
    // executeScript 的 args 不能含 undefined（会报 Value is unserializable），列表任务传空串。
    return await runInPage(CV_TARGET, cvResumeTaskInPage, [task, cvId ?? ""] as ["list" | "detail", string], true);
  } catch (error) {
    return { ok: false, error: error instanceof CvPageError ? error.info : { code: "PAGE_UNAVAILABLE", message: String(error) } };
  }
}

/** 读取当前账号的在线简历：只读，不写任何数据。 */
async function readOnlineResume(): Promise<OnlineReadOutcome> {
  try {
    return await runInPage(GEEK_TARGET, onlineResumeReadInPage, [] as [], true);
  } catch (error) {
    return { ok: false, error: error instanceof CvPageError ? error.info : { code: "PAGE_UNAVAILABLE", message: String(error) } };
  }
}

/** 读取写入用的字典（职位 / 行业 / 城市）：只读。 */
async function readOnlineDicts(): Promise<BossPageOutcome<OnlineDictTrees>> {
  try {
    return await runInPage(GEEK_TARGET, onlineDictInPage, [] as [], true);
  } catch (error) {
    return { ok: false, error: error instanceof CvPageError ? error.info : { code: "PAGE_UNAVAILABLE", message: String(error) } };
  }
}

/** 同一时间只允许一个同步写入任务：两次并发写入会互相覆盖，且必然有一条结果不可信。 */
let onlineWriting = false;

async function writeOnlineResume(operations: OnlineOperation[]): Promise<OnlineWriteResult> {
  if (onlineWriting) {
    return {
      ok: false,
      done: [],
      failed: [],
      skipped: operations.map((operation) => operation.label),
      ids: {},
      error: { code: "API_ERROR", message: "已有一个同步任务在进行，请等它结束再试" },
    };
  }
  onlineWriting = true;
  try {
    return await runInPage(GEEK_TARGET, onlineResumeWriteInPage, [operations], true);
  } catch (error) {
    const info: BossFetchError = error instanceof CvPageError ? error.info : { code: "PAGE_UNAVAILABLE", message: String(error) };
    return { ok: false, done: [], failed: [], skipped: operations.map((operation) => operation.label), ids: {}, error: info };
  } finally {
    onlineWriting = false;
  }
}

/** 同一时间只允许一个上传任务，防止重复点击建出多份简历。 */
let uploading = false;

/** 后台临时打开直聘简历页，按计划新建并填写简历，完成后关闭。 */
async function uploadResume(plan: UploadPlan): Promise<BossUploadResult> {
  if (uploading) return { ok: false, error: { code: "API_ERROR", message: "已有一个上传任务在进行，请等它结束" }, warnings: [] };
  uploading = true;
  try {
    return await runInPage(CV_TARGET, uploadResumeInPage, [plan], false);
  } catch (error) {
    const info: BossFetchError = error instanceof CvPageError ? error.info : { code: "NO_TAB", message: String(error) };
    const code = info.code === "NOT_LOGGED_IN" ? "NOT_LOGGED_IN" : "NO_TAB";
    return { ok: false, error: { code, message: info.message, detail: info.detail }, warnings: [] };
  } finally {
    uploading = false;
  }
}

/**
 * 只有扩展自身页面能触发读取、上传与录制开关；网页无法冒充。
 * 编辑页是在标签页里打开的，sender.tab 一定存在，只能按 URL 来源判断。
 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(`${extensionOrigin}/`);
}

/** BOSS 页面里的桥接脚本（content/captureBridge.ts）。 */
function fromBossContentScript(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    return /(^|\.)zhipin\.com$/.test(new URL(sender.url).hostname);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse): boolean | void => {
  const data = message as { type?: unknown; record?: unknown; cvId?: unknown; plan?: unknown; operations?: unknown } | null;
  const reply = (task: Promise<unknown>): true => {
    void task.then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  };

  if (fromBossContentScript(sender)) {
    if (data?.type === RECORD_STATUS_MESSAGE) return reply(getRecordingStatus());
    if (data?.type === RECORD_APPEND_MESSAGE) return reply(appendRecord(data.record));
    return;
  }
  if (!fromExtensionPage(sender)) return;

  switch (data?.type) {
    case BOSS_LIST_MESSAGE:
      return reply(readCv("list"));
    case BOSS_FETCH_MESSAGE:
      if (typeof data.cvId !== "string" || !data.cvId) return reply(Promise.resolve({ ok: false, error: { code: "API_ERROR", message: "缺少要读取的简历" } }));
      return reply(readCv("detail", data.cvId));
    case BOSS_UPLOAD_MESSAGE:
      if (!data.plan || typeof data.plan !== "object") return reply(Promise.resolve({ ok: false, error: { code: "API_ERROR", message: "缺少上传内容" }, warnings: [] }));
      return reply(uploadResume(data.plan as UploadPlan));
    case ONLINE_READ_MESSAGE:
      return reply(readOnlineResume());
    case ONLINE_DICT_MESSAGE:
      return reply(readOnlineDicts());
    case ONLINE_WRITE_MESSAGE:
      if (!Array.isArray(data.operations) || !data.operations.length) {
        return reply(Promise.resolve({ ok: false, done: [], failed: [], skipped: [], ids: {}, error: { code: "API_ERROR", message: "没有要写入的内容" } }));
      }
      return reply(writeOnlineResume(data.operations as OnlineOperation[]));
    case RECORD_STATUS_MESSAGE:
      return reply(getRecordingStatus());
    case RECORD_START_MESSAGE:
      return reply(startRecording());
    case RECORD_ATTACH_MESSAGE:
      return reply(attachRecorder());
    case RECORD_STOP_MESSAGE:
      return reply(stopRecording());
    default:
      return;
  }
});
