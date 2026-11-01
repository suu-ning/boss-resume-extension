import { describe, expect, it } from "vitest";
import { findDictEntry, flattenDict, normalizeDictName } from "../../src/boss/online/dict";

const tree = [
  {
    code: 1,
    name: "技术",
    subLevelModelList: [
      { code: 100101, name: "前端开发", subLevelModelList: [{ code: 10010101, name: "前端工程师", subLevelModelList: null }] },
      { code: 100102, name: "后端开发", subLevelModelList: null },
    ],
  },
  { code: 2, name: "产品", subLevelModelList: [{ code: 100201, name: "产品经理", subLevelModelList: null }] },
];

describe("flattenDict", () => {
  it("只收叶子时排除父节点，避免把「技术」这种大类当成职位编码", () => {
    const leaves = flattenDict(tree, true);
    expect(leaves.map((entry) => entry.name)).toEqual(["前端工程师", "后端开发", "产品经理"]);
    expect(leaves.some((entry) => entry.name === "技术")).toBe(false);
  });

  it("收全量时记下 parentCode，方便城市这种层级字典", () => {
    const all = flattenDict([{ code: 101020000, name: "上海", subLevelModelList: [{ code: 101020100, name: "上海", subLevelModelList: null }] }]);
    expect(all).toEqual([
      { code: 101020000, name: "上海", parentCode: 0 },
      { code: 101020100, name: "上海", parentCode: 101020000 },
    ]);
  });

  it("结构不对的节点直接跳过，不抛错", () => {
    expect(flattenDict(null)).toEqual([]);
    expect(flattenDict([{ code: "x", name: "坏数据" }, { code: 3, name: "" }])).toEqual([]);
  });
});

describe("findDictEntry", () => {
  const entries = flattenDict(tree, true);

  it("精确匹配优先", () => {
    expect(findDictEntry(entries, "后端开发")?.code).toBe(100102);
  });

  it("去掉「市/省」后缀与空白后仍能匹配", () => {
    expect(normalizeDictName(" 北京市 ")).toBe("北京");
    const cities = [
      { code: 101010100, name: "北京", parentCode: 0 },
      { code: 101020100, name: "上海", parentCode: 0 },
    ];
    expect(findDictEntry(cities, "北京市")?.code).toBe(101010100);
  });

  it("包含匹配只在结果唯一时才认，多个候选就不猜", () => {
    expect(findDictEntry(entries, "前端工程")?.code).toBe(10010101);
    expect(findDictEntry(entries, "开发")?.code).toBe(100102);
    // 「开发」同时命中两个岗位 → 不猜。
    const ambiguous = [
      { code: 1, name: "Java开发", parentCode: 0 },
      { code: 2, name: "Python开发", parentCode: 0 },
    ];
    expect(findDictEntry(ambiguous, "开发")).toBeUndefined();
  });

  it("查不到返回 undefined，由调用方决定沿用线上编码还是不写", () => {
    expect(findDictEntry(entries, "送外卖")).toBeUndefined();
    expect(findDictEntry(entries, "")).toBeUndefined();
    expect(findDictEntry([], "前端工程师")).toBeUndefined();
  });
});
