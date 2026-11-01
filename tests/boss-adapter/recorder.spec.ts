import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 录制脚本的注入与探活。
 *
 * 这里守的是一个真实踩过的坑：扩展重载后，已打开页面里的旧内容脚本会静默失效，
 * 计数一直是 0 而界面还显示「正在录制」。所以开始录制必须能主动把脚本接回去。
 */

interface FakeTab {
  id?: number;
  url?: string;
}

let tabs: FakeTab[] = [];
/** 这些 tab 的桥接脚本是活着的（ping 会回话）。 */
let alive = new Set<number>();
let store: Record<string, unknown> = {};
let injected: Array<{ tabId: number; files: string[]; world?: string }> = [];
/** 注入后是否能变成「活着」；设为 false 模拟注入也救不回来的页面。 */
let injectionWorks = true;

function installChrome(): void {
  const storage = {
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) delete store[key];
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: storage },
    tabs: {
      query: async () => tabs,
      sendMessage: async (tabId: number, message: { type?: string }) => {
        if (message?.type === "boss.record.ping") {
          if (!alive.has(tabId)) throw new Error("Could not establish connection. Receiving end does not exist.");
          return { ok: true, recording: true };
        }
        return undefined;
      },
    },
    scripting: {
      executeScript: async (injection: { target: { tabId: number }; files: string[]; world?: string }) => {
        injected.push({ tabId: injection.target.tabId, files: injection.files, world: injection.world });
        if (injectionWorks && injection.world !== "MAIN") alive.add(injection.target.tabId);
        return [];
      },
    },
  };
}

async function loadRecorder() {
  vi.resetModules();
  return import("../../src/background/recorder");
}

beforeEach(() => {
  tabs = [];
  alive = new Set();
  store = {};
  injected = [];
  injectionWorks = true;
  installChrome();
});

describe("attachRecorder", () => {
  it("已接上的标签不再重复注入", async () => {
    tabs = [{ id: 1, url: "https://www.zhipin.com/web/geek/resume" }];
    alive.add(1);
    const { attachRecorder } = await loadRecorder();

    const report = await attachRecorder();

    expect(report).toEqual({ matched: 1, alive: 1, failed: [] });
    expect(injected).toEqual([]);
  });

  it("旧脚本失效时重新注入主世界与桥接两段，注入后即可用", async () => {
    tabs = [{ id: 7, url: "https://www.zhipin.com/web/geek/resume" }];
    const { attachRecorder } = await loadRecorder();

    const report = await attachRecorder();

    expect(report.alive).toBe(1);
    expect(report.failed).toEqual([]);
    // 先补主世界的请求包装（幂等），再补隔离世界的桥接。
    expect(injected.map((item) => item.files)).toEqual([["content/networkCapture.js"], ["content/captureBridge.js"]]);
    expect(injected[0].world).toBe("MAIN");
    expect(injected[1].world).toBeUndefined();
  });

  it("注入后仍无回话时给出失败原因，不当成可用", async () => {
    tabs = [{ id: 9, url: "https://www.zhipin.com/web/geek/resume" }];
    injectionWorks = false;
    const { attachRecorder } = await loadRecorder();

    const report = await attachRecorder();

    expect(report.alive).toBe(0);
    expect(report.matched).toBe(1);
    expect(report.failed[0]).toContain("/web/geek/resume");
  });

  it("没有 BOSS 标签时返回 0，而不是报错", async () => {
    const { attachRecorder } = await loadRecorder();
    expect(await attachRecorder()).toEqual({ matched: 0, alive: 0, failed: [] });
  });

  it("跳过没有 id 的标签", async () => {
    tabs = [{ url: "https://www.zhipin.com/" }];
    const { attachRecorder } = await loadRecorder();

    const report = await attachRecorder();

    expect(report).toEqual({ matched: 1, alive: 0, failed: [] });
    expect(injected).toEqual([]);
  });
});

describe("startRecording", () => {
  it("开始录制会顺手把脚本接回去，并清空上一轮", async () => {
    tabs = [{ id: 3, url: "https://www.zhipin.com/web/geek/resume" }];
    store["record:items"] = [{ path: "old" }];
    const { startRecording } = await loadRecorder();

    const status = await startRecording();

    expect(status.recording).toBe(true);
    expect(status.count).toBe(0);
    expect(status.tabs).toEqual({ matched: 1, alive: 1, failed: [] });
    expect(injected).toHaveLength(2);
    expect(store["record:items"]).toEqual([]);
  });
});

describe("appendRecord", () => {
  it("未开始录制时丢弃记录", async () => {
    const { appendRecord, getRecordingStatus } = await loadRecorder();
    // getRecordingStatus 会顺手探活，这里只关心记录。
    await appendRecord({
      method: "GET",
      url: "https://www.zhipin.com/wapi/a.json",
      headerNames: [],
      requestBody: { kind: "none" },
      status: 200,
      responseText: "{}",
      at: Date.now(),
    });
    expect((await getRecordingStatus()).count).toBe(0);
  });
});
