import { describe, expect, it } from "vitest";
import { BossResumeAdapter, normalizeMonth } from "../../src/boss/resumeAdapter";
import { buildStructureSample } from "../../src/boss/structureSample";
import { copyResume, createBlankResume } from "../../src/domain/factories";
import { createResumeFromBossImport, refreshResumeFromBossImport } from "../../src/domain/bossImport";
import { buildUploadPlan } from "../../src/boss/uploadPlan";

// 字段名与格式照 2026-10-28 录制的 myresume/query.json 结构；内容为虚构。
const FETCHED_AT = "2026-10-27T08:00:00.000Z";
const detail = () => ({
  advantage: "擅长后端",
  profileVO: {
    name: "测试用户", gender: 1, birthday: "1995.06", workDate: "2018.07", locationName: "上海", positionName: "Java",
    lowSalary: 16, highSalary: 20, applyStatus: "离职-随时到岗", cvName: "Java 简历", templateId: "tpl-a", phone: "13800000000",
    politicalStatus: 0, nativePlaceName: null,
  },
  workExpVOList: [
    { id: "w1", company: "示例公司", positionName: "Java", startDateStr: "2020.03", endDateStr: "至今", endDate: 0, responsibility: "开发", workPerformance: "" },
    { id: "w2", company: "前公司", positionName: "Java", startDateStr: "2018.07", endDateStr: "2020.02", endDate: 202002, responsibility: "维护" },
  ],
  projectExpVOList: [{ id: "p1", name: "项目甲", roleName: "负责人", startDateStr: "2021.01", endDateStr: "2021.12", description: "描述", performance: "" }],
  eduExpVOList: [{ id: "e1", school: "示例大学", major: "计算机", degree: 203, degreeName: null, startYear: 2014, endYear: 2018, description: "" }],
});

describe("BossResumeAdapter.adaptDetail", () => {
  it("按 query.json 的字段映射", () => {
    const outcome = BossResumeAdapter.adaptDetail("cv-1", detail(), FETCHED_AT);
    if (!outcome.ok) throw new Error("unexpected");
    const { content, cvName, templateId, unmappedFields, remoteSnapshot, report } = outcome.result;
    expect(cvName).toBe("Java 简历");
    expect(templateId).toBe("tpl-a");
    expect(content.profile).toMatchObject({ name: "测试用户", gender: "male", birthDate: "1995-06", workStartDate: "2018-07" });
    expect(content.advantage).toBe("擅长后端");
    expect(content.jobIntent).toMatchObject({ cities: ["上海"], positions: ["Java"], salary: "16-20K" });
    expect(content.jobSearchStatus.status).toBe("离职-随时到岗");
    expect(content.workExperiences[0]).toMatchObject({ localId: "work-boss-w1", companyName: "示例公司", startDate: "2020-03", isCurrent: true });
    expect(content.workExperiences[0].endDate).toBeUndefined();
    expect(content.workExperiences[1]).toMatchObject({ endDate: "2020-02" });
    expect(content.workExperiences[1].isCurrent).toBeUndefined();
    expect(content.projects[0]).toMatchObject({ projectName: "项目甲", role: "负责人", startDate: "2021-01", endDate: "2021-12" });
    expect(content.educations[0]).toMatchObject({ schoolName: "示例大学", degree: "本科", startDate: "2014-09", endDate: "2018-06" });
    expect(unmappedFields).toEqual({ profileVO: { phone: "13800000000" } });
    expect(remoteSnapshot.cvId).toBe("cv-1");
    expect(report.missingGroups).toEqual([]);
  });

  it("教育经历的 isToday 转成「至今」，不再带结束月份", () => {
    const data = detail();
    const education = data.eduExpVOList[0] as Record<string, unknown>;
    education.isToday = true;
    education.endYear = 0;
    const outcome = BossResumeAdapter.adaptDetail("cv-1", data, FETCHED_AT);
    if (!outcome.ok) throw new Error("unexpected");
    expect(outcome.result.content.educations[0]).toMatchObject({ startDate: "2014-09", isCurrent: true });
    expect(outcome.result.content.educations[0].endDate).toBeUndefined();
  });

  it("提取专业技能并保留未识别的顶层数组模块", () => {
    const data = {
      ...detail(),
      professionalSkillVOList: [{ skillName: "TypeScript" }, { name: "Vue" }],
      customAwardVOList: [{ name: "优秀员工", year: 2024 }],
    };
    const outcome = BossResumeAdapter.adaptDetail("cv-1", data, FETCHED_AT);
    if (!outcome.ok) throw new Error("unexpected");
    expect(outcome.result.content.professionalSkills).toEqual(["TypeScript", "Vue"]);
    expect(outcome.result.content.customModules).toEqual([
      { key: "customAwardVOList", title: "Custom Award", items: [{ name: "优秀员工", year: 2024 }] },
    ]);
    expect(outcome.result.report.readGroups).toContainEqual({ label: "专业技能", count: 2 });
  });

  it("缺少 profileVO 时报格式错误", () => {
    const outcome = BossResumeAdapter.adaptDetail("cv-1", { foo: 1 });
    expect(!outcome.ok && outcome.error.code).toBe("UNEXPECTED_RESPONSE");
  });
});

describe("导入到本地简历", () => {
  const result = () => {
    const outcome = BossResumeAdapter.adaptDetail("cv-1", detail(), FETCHED_AT);
    if (!outcome.ok) throw new Error("unexpected");
    return outcome.result;
  };

  it("新建时用直聘简历名称做标题，记下 cvId 与样式模板，上传沿用该模板", () => {
    const created = createResumeFromBossImport(result(), { createId: () => "r1" });
    expect(created).toMatchObject({ localId: "r1", title: "Java 简历", source: "boss-import", syncState: "synced", bossCvId: "cv-1", bossTemplateId: "tpl-a" });
    expect(buildUploadPlan(created).templateId).toBe("tpl-a");
  });

  it("刷新保留本地标题；复制解除绑定但保留样式模板", () => {
    const target = { ...createBlankResume({ createId: () => "r2" }), title: "我的版本", syncState: "local-dirty" as const };
    const refreshed = refreshResumeFromBossImport(target, result(), FETCHED_AT);
    expect(refreshed).toMatchObject({ localId: "r2", title: "我的版本", syncState: "synced", bossTemplateId: "tpl-a" });
    const copy = copyResume(refreshed);
    expect(copy.bossCvId).toBeUndefined();
    expect(copy.bossTemplateId).toBe("tpl-a");
  });
});

describe("工具函数", () => {
  it("normalizeMonth", () => {
    expect(normalizeMonth("2020.3")).toBe("2020-03");
    expect(normalizeMonth("2020年11月")).toBe("2020-11");
    expect(normalizeMonth("202003")).toBe("2020-03");
    expect(normalizeMonth("至今")).toBeUndefined();
    expect(normalizeMonth("2020-13")).toBeUndefined();
  });

  it("结构样本不含个人内容", () => {
    const sample = buildStructureSample({ name: "张三", phone: 13800000000, gender: 1, list: [{ a: "x" }, { a: "y" }, { a: "z" }] });
    expect(sample).toEqual({ name: "<string:2>", phone: "<integer>", gender: "<integer:1>", list: ["<array:3>", { a: "<string:1>" }, { a: "<string:1>" }] });
    expect(JSON.stringify(sample)).not.toContain("张三");
  });
});
