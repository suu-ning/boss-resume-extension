import { describe, expect, it } from "vitest";
import { normalizeSectionOrder, sectionOrderFromSort } from "../../src/editor/sections";
import { BossResumeAdapter } from "../../src/boss/resumeAdapter";

describe("模块顺序", () => {
  it("缺失、重复、未知项都补齐为完整顺序", () => {
    expect(normalizeSectionOrder()).toEqual(["profile", "advantage", "professionalSkills", "work", "projects", "education", "customModules"]);
    expect(normalizeSectionOrder(["projects", "projects", "intent"])).toEqual(["profile", "projects", "advantage", "professionalSkills", "work", "education", "customModules"]);
  });

  it("旧简历只存了三个模块时自动补上教育经历", () => {
    expect(normalizeSectionOrder(["work", "advantage", "projects"])).toEqual(["profile", "work", "advantage", "professionalSkills", "projects", "education", "customModules"]);
  });

  it("直聘 sort 按模块编码取顺序，忽略基本信息", () => {
    expect(sectionOrderFromSort([1001, 1005, 1006, 1002, 1003])).toEqual(["profile", "projects", "education", "advantage", "professionalSkills", "work", "customModules"]);
    expect(sectionOrderFromSort("1001,1003,1002")).toEqual(["profile", "work", "advantage", "professionalSkills", "projects", "education", "customModules"]);
    expect(sectionOrderFromSort(undefined)).toEqual(["profile", "advantage", "professionalSkills", "work", "projects", "education", "customModules"]);
  });

  it("导入时从 profileVO.sort 读取顺序", () => {
    const outcome = BossResumeAdapter.adaptDetail("cv-1", { profileVO: { name: "张三", sort: [1001, 1003, 1005, 1002] } });
    if (!outcome.ok) throw new Error("unexpected");
    expect(outcome.result.content.sectionOrder).toEqual(["profile", "work", "projects", "advantage", "professionalSkills", "education", "customModules"]);
  });
});
