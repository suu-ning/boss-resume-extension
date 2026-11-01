import type {
  BossResumeDocument,
  ResumeIndexItem,
  ResumeSettings,
} from "../domain/types";
import { splitSkillItems } from "../domain/skills";
import {
  createDefaultLocalStorage,
  type LocalStorageArea,
} from "./storage";

export const RESUME_INDEX_KEY = "resume:index";
export const SETTINGS_KEY = "settings";

export function resumeStorageKey(localId: string): string {
  return `resume:${localId}`;
}

function toIndexItem(resume: BossResumeDocument): ResumeIndexItem {
  return {
    localId: resume.localId,
    title: resume.title,
    source: resume.source,
    updatedAt: resume.updatedAt,
    lastBossFetchedAt: resume.lastBossFetchedAt,
    lastBossUploadedAt: resume.lastBossUploadedAt,
    syncState: resume.syncState,
  };
}

function isIndexItem(value: unknown): value is ResumeIndexItem {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ResumeIndexItem).localId === "string" &&
    typeof (value as ResumeIndexItem).title === "string" &&
    typeof (value as ResumeIndexItem).updatedAt === "string"
  );
}

function isResumeDocument(value: unknown): value is BossResumeDocument {  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as BossResumeDocument).localId === "string" &&
    typeof (value as BossResumeDocument).title === "string" &&
    typeof (value as BossResumeDocument).updatedAt === "string"
  );
}

/**
 * 存量档案里可能有一条含多行的「专业技能」（AI 补全或导入时整段塞进一个元素），
 * 它在预览里只会渲染出一个圆点。读出来就按行拆开，下次保存时固化。
 */
function withNormalizedSkills(resume: BossResumeDocument): BossResumeDocument {
  const skills = resume.professionalSkills ?? [];
  const normalized = splitSkillItems(skills);
  const same = normalized.length === skills.length && normalized.every((item, index) => item === skills[index]);
  return same ? resume : { ...resume, professionalSkills: normalized };
}

export class ResumeRepository {
  public constructor(private readonly storage: LocalStorageArea = createDefaultLocalStorage()) {}

  public async list(): Promise<ResumeIndexItem[]> {
    const values = await this.storage.get(RESUME_INDEX_KEY);
    const index = values[RESUME_INDEX_KEY];

    if (!Array.isArray(index)) {
      return [];
    }

    return index
      .filter(isIndexItem)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async get(localId: string): Promise<BossResumeDocument | undefined> {
    const values = await this.storage.get(resumeStorageKey(localId));
    const resume = values[resumeStorageKey(localId)];
    return isResumeDocument(resume) ? withNormalizedSkills(resume) : undefined;
  }

  /** 写入完整文档，并在同一次 storage.set 调用中更新列表索引。 */
  public async save(document: BossResumeDocument): Promise<void> {
    const resume = withNormalizedSkills(document);
    const previousIndex = await this.list();
    const indexItem = toIndexItem(resume);
    const index = [
      ...previousIndex.filter((item) => item.localId !== resume.localId),
      indexItem,
    ];

    await this.storage.set({
      [resumeStorageKey(resume.localId)]: resume,
      [RESUME_INDEX_KEY]: index,
    });
  }

  /**
   * 删除一份本地简历：先从索引移除（列表立即不再显示），再删文档；若它是上次选中的简历，一并清除该设置。
   * 只影响本地，不触及 BOSS 在线简历。
   */
  public async remove(localId: string): Promise<void> {
    const index = (await this.list()).filter((item) => item.localId !== localId);
    const settings = await this.getSettings();
    await this.storage.set({
      [RESUME_INDEX_KEY]: index,
      ...(settings.lastSelectedResumeId === localId ? { [SETTINGS_KEY]: {} } : {}),
    });
    await this.storage.remove(resumeStorageKey(localId));
  }

  public async getSettings(): Promise<ResumeSettings> {
    const values = await this.storage.get(SETTINGS_KEY);
    const settings = values[SETTINGS_KEY];

    if (settings === null || typeof settings !== "object") {
      return {};
    }

    const lastSelectedResumeId = (settings as ResumeSettings).lastSelectedResumeId;
    return typeof lastSelectedResumeId === "string" ? { lastSelectedResumeId } : {};
  }

  public async saveSettings(settings: ResumeSettings): Promise<void> {
    await this.storage.set({ [SETTINGS_KEY]: settings });
  }
}
