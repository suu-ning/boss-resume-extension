import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlankResume } from "../../src/domain";
import { installCvApiInPage } from "../../src/boss/cvPageApi";
import { cvResumeTaskInPage } from "../../src/boss/pageFetch";
import { uploadResumeInPage } from "../../src/boss/pageUpload";
import { buildUploadPlan } from "../../src/boss/uploadPlan";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  params: URLSearchParams;
}

const ok = (zpData: unknown) => ({ code: 0, message: "Success", zpData });

function setup(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const responses: Record<string, unknown> = {
    "/wapi/zpcvresume/myresume/querylist.json": ok({
      maxCount: 5,
      myresumelist: [
        { templateId: "tpl-old", updateTime: 100 },
        { templateId: "tpl-style", updateTime: 200 },
      ],
    }),
    "/wapi/zpcvresume/myresume/syncfrombosszp.json": ok({ cvId: "cv-1" }),
    "/wapi/zpcvresume/myresume/query.json": ok({
      profileVO: { templateId: "tpl-style", location: 101010100, locationLv1: 101010100, locationName: "北京", phone: "138", sort: [1001, 1002], usedItemTypes: [0, 1] },
      workExpVOList: [{ id: "w-tpl" }],
      projectExpVOList: [{ id: "p-tpl" }],
      eduExpVOList: [{ id: "e-tpl" }],
    }),
    "/wapi/zpCommon/data/position.json": ok([{ code: 1, name: "技术", subLevelModelList: [{ code: 100101, name: "Java", subLevelModelList: null }] }]),
    "/wapi/zpcvresume/common/config/city.json": ok({ cityList: [{ code: 101020000, name: "上海", subLevelModelList: [{ code: 101020100, name: "上海", subLevelModelList: null }] }] }),
    ...overrides,
  };
  vi.stubGlobal("location", new URL("https://cv.zhipin.com/my-resumes/"));
  vi.stubGlobal("document", { cookie: "a=1; bst=token-value" });
  vi.stubGlobal("setTimeout", (fn: () => void) => (fn(), 0));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (href: string, init: RequestInit) => {
      const url = new URL(href);
      const params = init.method === "GET" ? url.searchParams : new URLSearchParams(String(init.body ?? ""));
      calls.push({ method: String(init.method), path: url.pathname, headers: init.headers as Record<string, string>, params });
      const body = responses[url.pathname] ?? ok({ id: "saved" });
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  vi.stubGlobal("window", {});
  installCvApiInPage();
  return calls;
}

function plan(works = 2) {
  const doc = createBlankResume({ createId: () => "r" });
  doc.title = "后端简历";
  doc.profile = { name: "张三", gender: "male", birthDate: "1995-06" };
  doc.jobIntent = { cities: ["上海"], positions: ["Java"], industries: [], salary: "15-20K" };
  doc.workExperiences = Array.from({ length: works }, (_, i) => ({
    localId: `w${i}`, companyName: `公司${i}`, positionName: "Java", startDate: "2020-03", isCurrent: i === works - 1, skills: [],
  }));
  doc.educations = [{ localId: "e", schoolName: "某大学", degree: "本科", startDate: "2014-09", endDate: "2018-06" }];
  return buildUploadPlan(doc);
}

afterEach(() => vi.unstubAllGlobals());

describe("uploadResumeInPage", () => {
  it("按录制顺序新建并保存，覆盖模板条目、新增不足、删除多余", async () => {
    const calls = setup();
    const result = await uploadResumeInPage(plan(2));
    expect(result).toMatchObject({ ok: true, cvId: "cv-1" });

    expect(calls[0].headers.zp_token).toBe("token-value");
    expect(calls[0].headers.traceId).toMatch(/^F-[2-9a-hjkmnp-z]{24}$/);

    const writes = calls.filter((c) => c.method === "POST").map((c) => c.path.replace("/wapi/zpcvresume/", ""));
    expect(writes).toEqual([
      "myresume/syncfrombosszp.json",
      "myresume/query.json",
      "myresume/updatecvname.json",
      "profile/save.json",
      "advantage/save.json",
      "skills/save.json",
      "workexp/save.json",
      "workexp/save.json",
      "projectexp/delete.json",
      "eduexp/save.json",
      "myresume/query.json",
    ]);

    expect(calls.find((c) => c.path.endsWith("syncfrombosszp.json"))!.params.get("templateId")).toBe("tpl-style");

    const profile = calls.find((c) => c.path.endsWith("profile/save.json"))!.params;
    expect(profile.get("cvId")).toBe("cv-1");
    expect(profile.get("templateId")).toBe("tpl-style");
    expect(profile.get("location")).toBe("101020100");
    expect(profile.get("position")).toBe("100101");
    expect(profile.get("birthday")).toBe("199506");
    expect(profile.get("usedItemTypes[1]")).toBe("1");
    expect(profile.get("phone")).toBe("138");

    const [first, second] = calls.filter((c) => c.path.endsWith("workexp/save.json")).map((c) => c.params);
    expect(first.get("id")).toBe("w-tpl");
    expect(second.get("id")).toBe("");
    expect(second.get("endDate")).toBe("0");
    expect(second.get("endDateStr")).toBe("至今");
    expect(calls.find((c) => c.path.endsWith("projectexp/delete.json"))!.params.get("id")).toBe("p-tpl");
    expect(calls.find((c) => c.path.endsWith("eduexp/save.json"))!.params.get("degree")).toBe("203");
  });

  it("模块顺序写进 profile 的 sort，基本信息等其他模块留在原位", async () => {
    const calls = setup({
      "/wapi/zpcvresume/myresume/query.json": ok({ profileVO: { sort: [1001, 1002, 1006, 1003, 1005] }, workExpVOList: [], projectExpVOList: [], eduExpVOList: [] }),
    });
    await uploadResumeInPage({ ...plan(), sectionCodes: [1005, 1006, 1003, 1002] });
    const profile = calls.find((c) => c.path.endsWith("profile/save.json"))!.params;
    expect(profile.get("sort")).toBe("1001,1005,1006,1003,1002");
  });

  it("将 BOSS 专业技能模块编码排在个人优势之后", async () => {
    const calls = setup({
      "/wapi/zpcvresume/myresume/query.json": ok({ profileVO: { sort: [1001, 1002, 1003, 1005] }, workExpVOList: [], projectExpVOList: [], eduExpVOList: [] }),
    });
    const built = plan(0);
    built.professionalSkills = { text: "Java", html: "<p>Java</p>" };
    built.sectionCodes = [1002, 2001, 1003, 1005, 1006];
    await uploadResumeInPage(built);
    const profile = calls.find((c) => c.path.endsWith("profile/save.json"))!.params;
    expect(profile.get("sort")).toBe("1001,1002,2001,1003,1005,1006");
  });

  it("直聘原来没有的模块补在末尾", async () => {
    const calls = setup({
      "/wapi/zpcvresume/myresume/query.json": ok({ profileVO: { sort: [1001, 1002, 1003, 1005] }, workExpVOList: [], projectExpVOList: [], eduExpVOList: [] }),
    });
    await uploadResumeInPage({ ...plan(), sectionCodes: [1006, 1002, 1003, 1005] });
    const profile = calls.find((c) => c.path.endsWith("profile/save.json"))!.params;
    expect(profile.get("sort")).toBe("1001,1006,1002,1003,1005");
  });

  it("教育经历勾了至今时写 isToday 并留空结束年份", async () => {
    const calls = setup();
    const built = plan(0);
    built.educations = [{ ...built.educations[0], current: true, endYear: undefined }];
    await uploadResumeInPage(built);
    const education = calls.find((c) => c.path.endsWith("eduexp/save.json"))!.params;
    expect(education.get("isToday")).toBe("true");
    expect(education.get("endYear")).toBe("-1");
    expect(education.get("endYearStr")).toBe("");
    expect(education.get("startYear")).toBe("2014");
  });

  it("写入专业技能纯文本和富文本，并在回读不一致时告警", async () => {
    const calls = setup();
    const built = plan(0);
    built.professionalSkills = { text: "Java\nSpring Boot", html: "<p>Java</p><p>Spring Boot</p>" };
    const result = await uploadResumeInPage(built);
    const saved = calls.find((call) => call.path.endsWith("skills/save.json"))!.params;
    expect(saved.get("content")).toBe("Java\nSpring Boot");
    expect(saved.get("contentRichText")).toBe("<p>Java</p><p>Spring Boot</p>");
    expect(saved.has("skills")).toBe(false);
    expect(result.ok && result.warnings).toContain("专业技能：BOSS 回读内容与本地不一致，请到直聘简历里核对");
  });

  it("份数已满时不新建", async () => {
    const calls = setup({ "/wapi/zpcvresume/myresume/querylist.json": ok({ maxCount: 5, myresumelist: [1, 2, 3, 4, 5] }) });
    const result = await uploadResumeInPage(plan());
    expect(result).toMatchObject({ ok: false, error: { code: "RESUME_FULL" } });
    expect(calls.some((c) => c.path.endsWith("syncfrombosszp.json"))).toBe(false);
  });

  it("没有已有简历时用直聘默认样式模板", async () => {
    const calls = setup({
      "/wapi/zpcvresume/myresume/querylist.json": ok({ maxCount: 5, myresumelist: [] }),
      "/wapi/zpcvresume/myresume/query.json": ok({ profileVO: {}, workExpVOList: [], projectExpVOList: [], eduExpVOList: [] }),
    });
    await uploadResumeInPage(plan());
    expect(calls.find((c) => c.path.endsWith("syncfrombosszp.json"))!.params.get("templateId")).toBe("7d133318365793281g~~");
  });

  it("中途失败时停止并带回已新建的 cvId", async () => {
    setup({ "/wapi/zpcvresume/advantage/save.json": { code: 1, message: "内容含敏感词" } });
    const result = await uploadResumeInPage(plan());
    expect(result).toMatchObject({ ok: false, cvId: "cv-1", error: { code: "API_ERROR", message: "内容含敏感词", step: "保存个人优势" } });
  });

  it("已绑定且直聘简历里还在时覆盖原简历，不新建", async () => {
    const calls = setup({
      "/wapi/zpcvresume/myresume/querylist.json": ok({ maxCount: 2, myresumelist: [{ id: "cv-bound", templateId: "tpl-bound" }, { id: "cv-x" }] }),
    });
    const result = await uploadResumeInPage({ ...plan(), cvId: "cv-bound" });
    expect(result).toMatchObject({ ok: true, cvId: "cv-bound", created: false });
    expect(calls.some((c) => c.path.endsWith("syncfrombosszp.json"))).toBe(false);
    const profile = calls.find((c) => c.path.endsWith("profile/save.json"))!.params;
    expect(profile.get("cvId")).toBe("cv-bound");
  });

  it("绑定的直聘简历已被删除时改为新建", async () => {
    const calls = setup();
    const result = await uploadResumeInPage({ ...plan(), cvId: "cv-gone" });
    expect(result).toMatchObject({ ok: true, cvId: "cv-1", created: true });
    expect(result.warnings).toContain("直聘简历里已经找不到原来那份简历，改为新建一份");
    expect(calls.some((c) => c.path.endsWith("syncfrombosszp.json"))).toBe(true);
  });

  it("本地简历记下的样式模板优先于最近编辑的那份", async () => {
    const calls = setup();
    await uploadResumeInPage({ ...plan(), templateId: "tpl-local" });
    expect(calls.find((c) => c.path.endsWith("syncfrombosszp.json"))!.params.get("templateId")).toBe("tpl-local");
  });
});

describe("cvResumeTaskInPage", () => {
  it("list 返回简历名称、模板与更新时间", async () => {
    setup({ "/wapi/zpcvresume/myresume/querylist.json": ok({ maxCount: 5, myresumelist: [{ id: "cv-a", cvName: "Java", templateId: "t", templateName: "简约", updateTime: 0 }, { cvName: "无 id" }] }) });
    const outcome = await cvResumeTaskInPage("list");
    expect(outcome).toEqual({ ok: true, data: { maxCount: 5, resumes: [{ cvId: "cv-a", cvName: "Java", templateId: "t", templateName: "简约", updatedAt: "1970-01-01T00:00:00.000Z" }] } });
  });

  it("detail 按 cvId 读取；登录失效时返回 NOT_LOGGED_IN", async () => {
    const calls = setup();
    const outcome = await cvResumeTaskInPage("detail", "cv-9");
    expect(outcome.ok).toBe(true);
    expect(calls[0].params.get("cvId")).toBe("cv-9");
    setup({ "/wapi/zpcvresume/myresume/query.json": { code: 37, message: "未登录" } });
    expect(await cvResumeTaskInPage("detail", "cv-9")).toMatchObject({ ok: false, error: { code: "NOT_LOGGED_IN" } });
  });
});
