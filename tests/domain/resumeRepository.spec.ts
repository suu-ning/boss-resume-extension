import { describe, expect, it } from "vitest";
import { createBlankResume } from "../../src/domain/factories";
import {
  RESUME_INDEX_KEY,
  ResumeRepository,
  resumeStorageKey,
} from "../../src/repository/resumeRepository";
import { MemoryLocalStorageArea } from "../../src/repository/storage";

describe("ResumeRepository", () => {
  it("使用规定键保存、读取并列出多份简历", async () => {
    const storage = new MemoryLocalStorageArea();
    const repository = new ResumeRepository(storage);
    const first = createBlankResume({
      now: "2026-10-01T00:00:00.000Z",
      createId: () => "first",
    });
    first.title = "第一份";
    const second = createBlankResume({
      now: "2026-10-02T00:00:00.000Z",
      createId: () => "second",
    });
    second.title = "第二份";

    await repository.save(first);
    await repository.save(second);

    expect(await repository.list()).toEqual([
      expect.objectContaining({ localId: "second", title: "第二份" }),
      expect.objectContaining({ localId: "first", title: "第一份" }),
    ]);
    expect(await repository.get("first")).toEqual(first);
    expect(await storage.get([RESUME_INDEX_KEY, resumeStorageKey("second")])).toMatchObject({
      [RESUME_INDEX_KEY]: expect.any(Array),
      [resumeStorageKey("second")]: second,
    });
  });

  it("隔离内存存储中的读写对象", async () => {
    const storage = new MemoryLocalStorageArea();
    const repository = new ResumeRepository(storage);
    const resume = createBlankResume({ createId: () => "resume-1" });
    resume.title = "原始标题";

    await repository.save(resume);
    resume.title = "内存外修改";
    const loaded = await repository.get("resume-1");
    loaded!.title = "读取后修改";

    expect((await repository.get("resume-1"))?.title).toBe("原始标题");
  });

  it("存量档案里一条含多行的专业技能，读出来按行拆开", async () => {
    const storage = new MemoryLocalStorageArea();
    const repository = new ResumeRepository(storage);
    const resume = createBlankResume({ createId: () => "skills" });
    resume.professionalSkills = ["熟练 Vue 3\n熟悉 React"];
    // 直接写存储，模拟旧版本留下的脏数据（save 会自动规范化，绕开它）。
    await storage.set({ [resumeStorageKey("skills")]: structuredClone(resume) });

    const loaded = await repository.get("skills");
    expect(loaded?.professionalSkills).toEqual(["熟练 Vue 3", "熟悉 React"]);
  });

  it("读写最后选中的简历设置", async () => {
    const repository = new ResumeRepository(new MemoryLocalStorageArea());

    expect(await repository.getSettings()).toEqual({});
    await repository.saveSettings({ lastSelectedResumeId: "resume-1" });
    expect(await repository.getSettings()).toEqual({ lastSelectedResumeId: "resume-1" });
  });
});

describe("ResumeRepository.remove", () => {
  it("删除文档与索引项，并清除指向它的上次选中设置", async () => {
    const storage = new MemoryLocalStorageArea();
    const repository = new ResumeRepository(storage);
    const keep = createBlankResume({ now: "2026-10-01T00:00:00.000Z", createId: () => "keep" });
    const drop = createBlankResume({ now: "2026-10-02T00:00:00.000Z", createId: () => "drop" });
    await repository.save(keep);
    await repository.save(drop);
    await repository.saveSettings({ lastSelectedResumeId: "drop" });

    await repository.remove("drop");

    expect((await repository.list()).map((item) => item.localId)).toEqual(["keep"]);
    expect(await repository.get("drop")).toBeUndefined();
    expect(await storage.get(resumeStorageKey("drop"))).toEqual({});
    expect(await repository.getSettings()).toEqual({});
    expect(await repository.get("keep")).toEqual(keep);
  });

  it("删除非选中简历时保留上次选中设置", async () => {
    const repository = new ResumeRepository(new MemoryLocalStorageArea());
    const a = createBlankResume({ createId: () => "a" });
    const b = createBlankResume({ createId: () => "b" });
    await repository.save(a);
    await repository.save(b);
    await repository.saveSettings({ lastSelectedResumeId: "a" });

    await repository.remove("b");

    expect(await repository.getSettings()).toEqual({ lastSelectedResumeId: "a" });
  });
});
