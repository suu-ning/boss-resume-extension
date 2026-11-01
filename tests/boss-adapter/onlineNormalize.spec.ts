import { describe, expect, it } from "vitest";
import { multiline, plain, sameText } from "../../src/boss/online/normalize";

/**
 * 两套文本口径的分工（写入口径 vs 比对口径）：
 * - multiline 给请求体用，必须保留换行；
 * - plain 给差异比对用，必须把换行抹平，否则线上被服务端压平后会永久显示差异。
 */
describe("multiline / plain", () => {
  it("multiline 保留换行，统一 \\r\\n 与行尾空白", () => {
    expect(multiline("第一行\n第二行")).toBe("第一行\n第二行");
    expect(multiline("第一行\r\n第二行\r第三行")).toBe("第一行\n第二行\n第三行");
    expect(multiline("  第一行  \n\n  第二行\t")).toBe("第一行\n\n第二行");
  });

  it("multiline 去掉首尾空行，连续空行最多留一个", () => {
    expect(multiline("\n\n第一行\n\n\n\n第二行\n\n")).toBe("第一行\n\n第二行");
  });

  it("multiline 对空值返回空串", () => {
    expect(multiline(undefined)).toBe("");
    expect(multiline(null)).toBe("");
    expect(multiline("   \n  ")).toBe("");
  });

  it("plain 仍然压平换行与连续空白", () => {
    expect(plain("第一行\n第二行")).toBe("第一行 第二行");
    expect(plain("第一行\n\n第二行")).toBe("第一行 第二行");
  });

  it("plain 把线上回传的 <br>、</p> 当分隔，避免假差异", () => {
    expect(plain("第一行<br>第二行")).toBe("第一行 第二行");
    expect(plain("第一行<br/>第二行")).toBe("第一行 第二行");
    expect(plain("<p>第一行</p><p>第二行</p>")).toBe("第一行 第二行");
    expect(sameText("第一行\n第二行", "第一行<br>第二行")).toBe(true);
  });

  it("写入口径与比对口径兼容：多行原文与压平后的线上值判为一致", () => {
    const local = "职责一\n职责二\n\n职责三";
    const remote = "职责一 职责二 职责三";
    expect(sameText(local, remote)).toBe(true);
    expect(sameText(multiline(local), remote)).toBe(true);
  });
});
