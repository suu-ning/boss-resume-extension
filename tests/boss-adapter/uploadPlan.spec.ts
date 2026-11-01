import { describe, expect, it } from "vitest";
import { createBlankResume } from "../../src/domain";
import { buildUploadPlan, parseSalary, toUploadMonth, toUploadText } from "../../src/boss/uploadPlan";

const resume = () => {
  const doc = createBlankResume({ now: "2026-10-28T00:00:00.000Z", createId: () => "r1" });
  doc.title = "后端简历";
  doc.profile = { name: "张三", gender: "male", birthDate: "1995-06", workStartDate: "2018-07" };
  doc.advantage = "熟悉 Java\n擅长 <性能> 优化";
  doc.jobIntent = { cities: ["上海", "杭州"], positions: ["Java"], industries: ["金融"], salary: "15-20K" };
  doc.workExperiences = [
    { localId: "w1", companyName: "甲公司", positionName: "Java", startDate: "2020-03", endDate: "2022-01", skills: [] },
    { localId: "w2", companyName: "乙公司", positionName: "Java", startDate: "2022-02", isCurrent: true, endDate: "2024-01", skills: ["Spring"] },
  ];
  doc.educations = [{ localId: "e1", schoolName: "某大学", degree: "本科", major: "计算机", startDate: "2014-09", endDate: "2018-06" }];
  return doc;
};

describe("uploadPlan 转换", () => {
  it("月份、薪资、富文本格式与录制一致", () => {
    expect(toUploadMonth("2020-03")).toEqual({ compact: "202003", dot: "2020.03", dash: "2020-03" });
    expect(toUploadMonth("")).toBeUndefined();
    expect(parseSalary("15k~20k")).toEqual([15, 20]);
    expect(parseSalary("面议")).toBeUndefined();
    expect(toUploadText("a\n<b>")).toEqual({ text: "a\n<b>", html: "<p>a</p><p>&lt;b&gt;</p>" });
  });

  it("生成计划：性别码、学历码、至今、只取第一个城市", () => {
    const plan = buildUploadPlan(resume());
    expect(plan.blockers).toEqual([]);
    expect(plan.profile).toMatchObject({ name: "张三", gender: 1, cityName: "上海", positionName: "Java", lowSalary: 15, highSalary: 20 });
    expect(plan.works[1]).toMatchObject({ current: true, end: undefined });
    expect(plan.educations[0]).toMatchObject({ degree: 203, startYear: 2014, endYear: 2018 });
    expect(plan.notes.some((note) => note.includes("上海"))).toBe(true);
    expect(plan.notUploaded).toContain("期望行业");
    expect(plan.notUploaded).toContain("工作经历中的行业、部门与技能标签");
  });

  it("未知学历留空并提示；无姓名、超过 10 段时阻止上传", () => {    const doc = resume();
    doc.profile.name = "";
    doc.educations[0].degree = "MBA";
    doc.workExperiences = Array.from({ length: 11 }, (_, i) => ({ ...doc.workExperiences[0], localId: `w${i}` }));
    const plan = buildUploadPlan(doc);
    expect(plan.educations[0].degree).toBe(0);
    expect(plan.notes.some((note) => note.includes("MBA"))).toBe(true);
    expect(plan.blockers).toHaveLength(2);
  });

  it("教育经历勾了至今就不带结束年份", () => {
    const doc = resume();
    doc.educations[0].isCurrent = true;
    const plan = buildUploadPlan(doc);
    expect(plan.educations[0]).toMatchObject({ current: true, startYear: 2014, endYear: undefined });
  });

  it("专业技能加入上传计划，自定义模块仍提示未验证写入", () => {
    const doc = resume();
    doc.professionalSkills = ["Java", "Spring Boot"];
    doc.customModules = [{ key: "awardList", title: "荣誉奖项", items: [{ name: "优秀员工" }] }];
    const plan = buildUploadPlan(doc);
    expect(plan.professionalSkills).toEqual({ text: "Java\nSpring Boot", html: "<p>Java</p><p>Spring Boot</p>" });
    expect(plan.sectionCodes).toEqual([1001, 1002, 2001, 1003, 1005, 1006]);
    expect(plan.notUploaded.some((item) => item.includes("自定义模块") && item.includes("不会自动添加"))).toBe(true);
    doc.bossCvId = "cv-existing";
    const boundPlan = buildUploadPlan(doc);
    expect(boundPlan.professionalSkills.text).toBe("Java\nSpring Boot");
  });

  it("计划可 JSON 序列化（要作为 executeScript 参数传入页面）", () => {
    const plan = buildUploadPlan(resume());
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});
