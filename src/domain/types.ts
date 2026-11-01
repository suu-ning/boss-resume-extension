export type BossResumeSource = "boss-import" | "manual" | "copy";

export type BossResumeSyncState = "unbound" | "synced" | "local-dirty";

/** BOSS 返回但本地尚未建立专用编辑器的模块，保留原始条目避免导入/AI 时丢失。 */
export interface BossCustomModule {
  key: string;
  title: string;
  items: unknown[];
}

export interface BossResumeDocument {
  localId: string;
  title: string;
  source: BossResumeSource;
  createdAt: string;
  updatedAt: string;
  lastBossFetchedAt?: string;
  /** 最近一次成功上传到 BOSS（新增一份简历）的时间；上传不改变 BOSS 已有简历。 */
  lastBossUploadedAt?: string;
  syncState: BossResumeSyncState;
  /** 从直聘简历读取时那份简历的 cvId；刷新时按它重新读取。 */
  bossCvId?: string;
  /** 直聘简历的样式模板；上传时沿用，保证拉取后再上传样式不变。复制时保留。 */
  bossTemplateId?: string;
  /** 个人优势 / 工作经历 / 项目经历 / 教育经历的显示顺序（advantage、work、projects、education），对应直聘简历的模块排序。缺省按默认顺序。 */
  sectionOrder?: string[];
  profile: BossProfile;
  advantage: string;
  jobIntent: BossJobIntent;
  workExperiences: BossWorkExperience[];
  projects: BossProject[];
  educations: BossEducation[];
  professionalSkills: string[];
  customModules: BossCustomModule[];
  certificates: BossCertificate[];
  socialProfiles: BossSocialProfile[];
  volunteerExperiences: BossVolunteerExperience[];
  jobSearchStatus: BossJobSearchStatus;
  remoteSnapshot?: BossRemoteSnapshot;
  unmappedFields?: Record<string, unknown>;
  /** 最近一次读取在线简历（www.zhipin.com）的时间。 */
  onlineFetchedAt?: string;
  /** 最近一次读取的在线简历原始数据：既用于差异对比，也是写回失败时回滚的依据。 */
  onlineSnapshot?: BossOnlineSnapshot;
  /** 同步到在线简历时，对「容易影响推荐」的字段怎么取舍。 */
  onlineSyncOptions?: OnlineSyncOptions;
}

/** 在线简历里可以被单独勾选同步的模块。 */
export type OnlineModuleId =
  | "baseInfo"
  | "advantage"
  | "professionalSkill"
  | "expect"
  | "work"
  | "project"
  | "education"
  | "certificate";

/**
 * 同步到在线简历时的取舍开关。
 *
 * 默认全部保留线上原值：求职状态与期望行业直接进入推荐与投递链路，跟着本地档案覆盖风险过高，
 * 只有用户显式打开才按本地覆盖。
 */
export interface OnlineSyncOptions {
  /** 求职状态（applyStatus）：默认保留线上值。 */
  syncJobStatus: boolean;
  /** 期望行业：默认保留线上值。 */
  syncIndustries: boolean;
  /**
   * 本次要同步的模块（多选）。undefined 表示全选，用于兼容没有这个字段的旧档案；
   * 空数组表示一个都不选，此时不会写入任何内容。
   */
  modules?: OnlineModuleId[];
}

/** 在线简历原始快照（geek/preview/data.json 的 zpData 原样保存）。 */
export interface BossOnlineSnapshot {
  capturedAt: string;
  rawData: Record<string, unknown>;
}

export interface BossProfile {
  avatar?: string;
  name: string;
  gender?: "male" | "female" | "unknown";
  jobIdentity?: string;
  workStartDate?: string;
  birthDate?: string;
}

export interface BossJobIntent {
  jobType?: string;
  cities: string[];
  positions: string[];
  jobPreference?: string;
  salary?: string;
  industries: string[];
}

export interface BossWorkExperience {
  localId: string;
  companyName: string;
  industry?: string;
  department?: string;
  positionName: string;
  startDate: string;
  endDate?: string;
  isCurrent?: boolean;
  responsibilities?: string;
  skills: string[];
  achievements?: string;
}

export interface BossProject {
  localId: string;
  projectName: string;
  role?: string;
  startDate: string;
  endDate?: string;
  /** 项目仍在进行，结束时间显示为「至今」。 */
  isCurrent?: boolean;
  description?: string;
  achievements?: string;
  link?: string;
}

export interface BossEducation {
  localId: string;
  schoolName: string;
  degree?: string;
  major?: string;
  startDate?: string;
  endDate?: string;
  /** 仍在读，结束时间显示为「至今」。 */
  isCurrent?: boolean;
  campusExperience?: string;
  thesis?: string;
}

export interface BossCertificate {
  localId: string;
  name: string;
  issuer?: string;
  credentialId?: string;
  issueDate?: string;
  expiryDate?: string;
  description?: string;
}

export interface BossSocialProfile {
  localId: string;
  platform: string;
  url: string;
  label?: string;
}

export interface BossVolunteerExperience {
  localId: string;
  organizationName: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

export interface BossJobSearchStatus {
  status?: string;
  availableDate?: string;
  preferredContactTime?: string;
  note?: string;
}

/** 从 BOSS 读取的原始响应，仅作为本地兼容与对比资料保留，不用于拼装上传请求。 */
export interface BossRemoteSnapshot {
  capturedAt: string;
  source: "fetch";
  /** 直聘简历 cvId；旧数据（从 www.zhipin.com 捕获）没有。 */
  cvId?: string;
  rawData: Record<string, unknown>;
  version?: string;
}

export interface ResumeIndexItem {
  localId: string;
  title: string;
  source: BossResumeSource;
  updatedAt: string;
  lastBossFetchedAt?: string;
  /** 最近一次成功上传到 BOSS（新增一份简历）的时间；上传不改变 BOSS 已有简历。 */
  lastBossUploadedAt?: string;
  syncState: BossResumeSyncState;
}

export interface ResumeSettings {
  lastSelectedResumeId?: string;
}
