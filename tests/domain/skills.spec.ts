import { describe, expect, it } from "vitest";
import { splitSkillItems } from "../../src/domain/skills";

/**
 * 专业技能约定「一行一条」。历史数据里出现过整段塞进一个元素的情况，
 * 预览按条目渲染时只会出一个圆点，因此读写入口统一按行拆开。
 */
describe("splitSkillItems", () => {
  it("一条里含多行时按行拆开", () => {
    expect(splitSkillItems(["熟练 Vue 3\n熟悉 React\r\n了解 Node"])).toEqual(["熟练 Vue 3", "熟悉 React", "了解 Node"]);
  });

  it("单行条目原样保留，顺序不变", () => {
    expect(splitSkillItems(["Vue 3", "React 18"])).toEqual(["Vue 3", "React 18"]);
  });

  it("去掉空白行、首尾空白与重复项", () => {
    expect(splitSkillItems(["  Vue 3 \n\n  Vue 3  \n React "])).toEqual(["Vue 3", "React"]);
  });

  it("空数组与缺省值返回空数组", () => {
    expect(splitSkillItems([])).toEqual([]);
    expect(splitSkillItems(undefined)).toEqual([]);
    expect(splitSkillItems(null)).toEqual([]);
  });
});
