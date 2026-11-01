import { afterEach, describe, expect, it, vi } from "vitest";
import { askResumeAssistant, editableView, summarizeChanges } from "../../src/ai/resumeAssistant";
import { applyAiResume, normalizeAiText, normalizeDate } from "../../src/ai/resumePatch";
import { createBlankResume } from "../../src/domain/factories";
import type { BossResumeDocument } from "../../src/domain/types";

function sample(): BossResumeDocument {
  const resume = createBlankResume({ now: "2026-10-28T00:00:00.000Z", createId: () => "r1" });
  resume.title = "Java 开发";
  resume.profile = { name: "张三", avatar: "https://img/a.png" };
  resume.bossCvId = "cv-1";
  resume.syncState = "synced";
  resume.workExperiences = [
    { localId: "work-1", companyName: "港证软件", positionName: "Java 开发工程师", startDate: "2022-03", isCurrent: true, skills: ["Java"] },
    { localId: "work-2", companyName: "小花网络", positionName: "", startDate: "2019-07", endDate: "2022-02", skills: [] },
  ];
  return resume;
}

describe("applyAiResume", () => {
  it("按 localId 合并条目，保留绑定信息和头像，新条目生成新 ID", () => {
    const base = sample();
    const next = applyAiResume(base, {
      profile: { name: "张三", avatar: "https://evil/x.png" },
      bossCvId: "hacked",
      workExperiences: [
        { localId: "work-2", positionName: "后端开发工程师", endDate: "2022.2" },
        { companyName: "新公司", positionName: "架构师", startDate: "2018年1月", skills: ["Go", "Go", 1] },
      ],
    });

    expect(next.bossCvId).toBe("cv-1");
    expect(next.syncState).toBe("synced");
    expect(next.profile.avatar).toBe("https://img/a.png");
    expect(next.workExperiences).toHaveLength(2);
    expect(next.workExperiences[0]).toMatchObject({ localId: "work-2", companyName: "小花网络", positionName: "后端开发工程师", endDate: "2022-02" });
    expect(next.workExperiences[1].localId).toMatch(/^work-/);
    expect(next.workExperiences[1]).toMatchObject({ startDate: "2018-01", skills: ["Go", "1"] });
    expect(base.workExperiences).toHaveLength(2);
  });

  it("至今的经历不保留结束时间；未提供的模块保持原样", () => {
    const base = sample();
    base.professionalSkills = ["Java", "Spring"];
    base.customModules = [{ key: "awardList", title: "荣誉奖项", items: [{ name: "优秀员工" }] }];
    const next = applyAiResume(base, { workExperiences: [{ localId: "work-1", isCurrent: true, endDate: "2026-01" }] });
    expect(next.workExperiences[0].endDate).toBeUndefined();
    expect(next.educations).toEqual(base.educations);
    expect(next.professionalSkills).toEqual(base.professionalSkills);
    expect(next.customModules).toEqual(base.customModules);
    expect(editableView(base)).toMatchObject({ professionalSkills: ["Java", "Spring"], customModules: base.customModules });
  });

  it("识别常见日期写法", () => {
    expect(normalizeDate("2020/3")).toBe("2020-03");
    expect(normalizeDate("2020-03-05")).toBe("2020-03-05");
    expect(normalizeDate("至今")).toBe("至今");
  });

  it("还原 AI 文本里的转义换行并保留正常换行", () => {
    expect(normalizeAiText("第一行\\n第二行\\n\\n第三行\n第四行")).toBe("第一行\n第二行\n\n第三行\n第四行");
    const next = applyAiResume(sample(), {
      advantage: "第一行\\n第二行",
      workExperiences: [{ localId: "work-1", responsibilities: "负责接口开发\\n推动上线" }],
      professionalSkills: ["TypeScript\\nVue", "Java"],
    });
    expect(next.advantage).toBe("第一行\n第二行");
    expect(next.workExperiences[0].responsibilities).toBe("负责接口开发\n推动上线");
    // 技能是「一行一条」：模型把两行塞进一个元素时按行拆开，否则预览只出一个圆点。
    expect(next.professionalSkills).toEqual(["TypeScript", "Vue", "Java"]);
  });
});

describe("askResumeAssistant", () => {
  afterEach(() => vi.unstubAllGlobals());

  const settings = { apiKey: "sk-test", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" };

  function stubReply(content: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] })));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("返回修改后的简历与按模块汇总的改动", async () => {
    const base = sample();
    const fetchMock = stubReply({ reply: "已补全职位", resume: { advantage: "5 年 Java 经验", workExperiences: [base.workExperiences[0], { ...base.workExperiences[1], positionName: "Java 开发工程师" }] } });

    const result = await askResumeAssistant(settings, base, [], "补全职位");

    expect(result.reply).toBe("已补全职位");
    expect(result.resume?.workExperiences[1].positionName).toBe("Java 开发工程师");
    expect(summarizeChanges(result.changes)).toEqual(["个人优势 · 1 处", "工作经历 · 1 处"]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).not.toContain("https://img/a.png");
  });

  it("补充材料随 system prompt 一起发出", async () => {
    const fetchMock = stubReply({ reply: "已按材料补全", resume: null });
    await askResumeAssistant(settings, sample(), [], "按材料补全", {
      materials: [{ id: "m1", name: "JD.md", chars: 14, truncated: false, text: "岗位职责：负责 Java 后端" }],
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain("【JD.md】");
    expect(body.messages[0].content).toContain("负责 Java 后端");
  });

  it("把图片作为 OpenAI 兼容的视觉消息发送", async () => {
    const fetchMock = stubReply({ reply: "已根据截图调整", resume: null });
    await askResumeAssistant(settings, sample(), [], "按截图中的 JD 优化", {
      images: [{ id: "image-1", name: "jd.png", mimeType: "image/png", bytes: 3, dataUrl: "data:image/png;base64,YWJj" }],
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages.at(-1).content).toEqual([
      { type: "text", text: "按截图中的 JD 优化" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
    ]);
  });

  it("resume 为 null 时只返回回复", async () => {
    stubReply({ reply: "请提供岗位 JD", resume: null });
    const result = await askResumeAssistant(settings, sample(), [], "按 JD 优化");
    expect(result).toEqual({ reply: "请提供岗位 JD", changes: [] });
  });

  it("把回复中的字面量转义换行还原成真实换行", async () => {
    stubReply({ reply: "第一行\\n\\n第二行", resume: null });
    const result = await askResumeAssistant(settings, sample(), [], "请总结");
    expect(result.reply).toBe("第一行\n\n第二行");
  });

  it("模型只回了一段文字时当作回复展示，不改简历", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "转全栈建议：\n1. 个人优势补前端技能" } }] })));
    const result = await askResumeAssistant(settings, sample(), [], "转全栈要改哪些");
    expect(result).toEqual({ reply: "转全栈建议：\n1. 个人优势补前端技能", changes: [] });
  });

  it("401 转成可读的错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(askResumeAssistant(settings, sample(), [], "hi")).rejects.toThrow("API Key 无效");
  });
});
