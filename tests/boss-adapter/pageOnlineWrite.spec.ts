import { afterEach, describe, expect, it, vi } from "vitest";
import { installCvApiInPage } from "../../src/boss/cvPageApi";
import { onlineResumeWriteInPage } from "../../src/boss/online/pageWrite";
import type { OnlineOperation } from "../../src/boss/online/types";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  params: URLSearchParams;
}

const ok = (zpData: unknown) => ({ code: 0, message: "Success", zpData });

function setup(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("location", new URL("https://www.zhipin.com/web/geek/resume"));
  vi.stubGlobal("document", { cookie: "bst=zp-token" });
  vi.stubGlobal("setTimeout", (fn: () => void) => (fn(), 0));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (href: string, init: RequestInit) => {
      const url = new URL(href);
      const params = init.method === "GET" ? url.searchParams : new URLSearchParams(String(init.body ?? ""));
      calls.push({ method: String(init.method), path: url.pathname, headers: init.headers as Record<string, string>, params });
      const body = responses[url.pathname] ?? ok({});
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  vi.stubGlobal("window", {});
  installCvApiInPage();
  return calls;
}

const advantage: OnlineOperation = {
  key: "advantage",
  module: "advantage",
  label: "更新个人优势",
  action: "save",
  path: "/wapi/zpgeek/resume/userdesc/save.json",
  precheck: { method: "POST", path: "/wapi/zpgeek/resume/userdesc/precheck.json", payload: { userDesc: "新的优势" } },
  payload: { advantage: "新的优势", entrance: 1, riskTipType: 1, xGeekBizSource: "pc_online_resume" },
};

const certificate: OnlineOperation = {
  key: "certificate",
  module: "certificate",
  label: "覆盖资格证书",
  action: "save",
  path: "/wapi/zpgeek/resume/certification/save.json",
  payload: { certJson: [{ name: "PMP", type: 0 }] },
};

afterEach(() => vi.unstubAllGlobals());

describe("onlineResumeWriteInPage", () => {
  it("逐条执行：前置校验在前，保存带上录制字段", async () => {
    const calls = setup();
    const result = await onlineResumeWriteInPage([advantage, certificate]);

    expect(result.ok).toBe(true);
    expect(result.done.map((item) => item.key)).toEqual(["advantage", "certificate"]);
    expect(calls.map((call) => call.path)).toEqual([
      "/wapi/zpgeek/resume/userdesc/precheck.json",
      "/wapi/zpgeek/resume/userdesc/save.json",
      "/wapi/zpgeek/resume/certification/save.json",
    ]);
    const save = calls[1];
    expect(save.method).toBe("POST");
    expect(save.headers.zp_token).toBe("zp-token");
    expect(save.params.get("advantage")).toBe("新的优势");
    expect(save.params.get("xGeekBizSource")).toBe("pc_online_resume");
    // 嵌套数组按 key[i][子字段] 展开，这是 multiExpectInfos 那种结构能写对的前提。
    expect(calls[2].params.get("certJson[0][name]")).toBe("PMP");
  });

  it("前置校验返回 dialog 非空时放弃这一条，不继续保存", async () => {
    const calls = setup({ "/wapi/zpgeek/resume/userdesc/precheck.json": ok({ dialog: { title: "请先完善头像" } }) });
    const result = await onlineResumeWriteInPage([advantage]);

    expect(result.ok).toBe(false);
    expect(result.failed[0].message).toContain("请先完善头像");
    expect(calls.some((call) => call.path.endsWith("userdesc/save.json"))).toBe(false);
  });

  it("新建条目返回的 encryptId 记下来，方便下次按 id 更新", async () => {
    setup({ "/wapi/zpgeek/resume/workexp/save.json": ok({ encryptId: "new-id" }) });
    const result = await onlineResumeWriteInPage([
      {
        key: "work-2",
        module: "work",
        label: "新增工作经历 · C 公司",
        action: "save",
        path: "/wapi/zpgeek/resume/workexp/save.json",
        payload: { companyName: "C 公司" },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.ids).toEqual({ "work-2": "new-id" });
  });

  it("登录失效立即停下，后面的动作标成未执行", async () => {
    setup({ "/wapi/zpgeek/resume/userdesc/save.json": { code: 37, message: "未登录" } });
    const result = await onlineResumeWriteInPage([advantage, certificate]);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_LOGGED_IN");
    expect(result.done).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.skipped).toEqual(["覆盖资格证书"]);
  });

  it("业务错误只记这一条，后面的继续执行", async () => {
    setup({ "/wapi/zpgeek/resume/certification/save.json": { code: 4001, message: "证书名称过长" } });
    const result = await onlineResumeWriteInPage([advantage, certificate]);

    expect(result.ok).toBe(false);
    expect(result.done.map((item) => item.key)).toEqual(["advantage"]);
    expect(result.failed[0]).toMatchObject({ key: "certificate", code: "API_ERROR", message: "证书名称过长" });
    expect(result.error).toBeUndefined();
  });

  it("带了 token 被判未登录时，去掉 token 重试一次", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("location", new URL("https://www.zhipin.com/web/geek/resume"));
    vi.stubGlobal("document", { cookie: "bst=zp-token; zp_at=wrong-token" });
    vi.stubGlobal("setTimeout", (fn: () => void) => (fn(), 0));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (href: string, init: RequestInit) => {
        const url = new URL(href);
        const headers = init.headers as Record<string, string>;
        calls.push({ method: String(init.method), path: url.pathname, headers, params: new URLSearchParams(String(init.body ?? "")) });
        // 只要带了 token 头就判未登录。
        const body = headers.token ? { code: 37, message: "未登录" } : ok({});
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    vi.stubGlobal("window", {});
    installCvApiInPage();

    const result = await onlineResumeWriteInPage([certificate]);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.token).toBe("wrong-token");
    expect(calls[1].headers.token).toBeUndefined();
  });
});
