import { diffResumes, type ResumeFieldDiff } from "../domain/diff";
import type { BossResumeDocument } from "../domain/types";
import { chatReply, type ChatContent, type ChatMessage } from "./chatClient";
import type { AiImage } from "./images";
import { buildMaterialsBlock, type ResumeMaterial } from "./materials";
import { applyAiResume, normalizeAiText } from "./resumePatch";
import type { AiSettings } from "./settings";

export interface AiTurn {
  role: "user" | "assistant";
  content: ChatContent;
}

export interface AiEditResult {
  reply: string;
  /** AI 改过的整份简历；没有改动时为 undefined。 */
  resume?: BossResumeDocument;
  changes: ResumeFieldDiff[];
}

/** 只带最近几轮对话，控制请求体积；简历本身每次都完整附上。 */
const HISTORY_LIMIT = 12;

/** 交给 AI 的可编辑内容：去掉头像、同步状态、远程快照等与写作无关的字段。 */
export function editableView(resume: BossResumeDocument): Record<string, unknown> {
  const { avatar: _avatar, ...profile } = resume.profile;
  return {
    title: resume.title,
    profile,
    advantage: resume.advantage,
    jobIntent: resume.jobIntent,
    workExperiences: resume.workExperiences,
    projects: resume.projects,
    educations: resume.educations,
    professionalSkills: resume.professionalSkills ?? [],
    customModules: resume.customModules ?? [],
    certificates: resume.certificates,
    socialProfiles: resume.socialProfiles,
    volunteerExperiences: resume.volunteerExperiences,
    jobSearchStatus: resume.jobSearchStatus,
  };
}

function systemPrompt(resume: BossResumeDocument, materials: ResumeMaterial[]): string {
  const hasMaterials = materials.length > 0;
  return [
    "你是资深的中文简历顾问，帮用户修改一份要上传到 BOSS 直聘的在线简历。",
    "",
    "当前简历（json）：",
    JSON.stringify(editableView(resume), null, 2),
    buildMaterialsBlock(materials),
    "修改规则：",
    "- 日期一律用 YYYY-MM；isCurrent 为 true 表示「至今」，此时不要填 endDate。",
    "- 已有条目的 localId 必须原样保留；新增条目不写 localId；删除条目就从数组里去掉。",
    "- gender 只能是 male / female / unknown；skills、cities、positions、industries 是字符串数组。",
    "- professionalSkills 是专业技能字符串数组；customModules 是从 BOSS 读取的其他模块原始条目。除非用户明确要求修改，否则必须完整保留这两个字段。",
    "- 必填：简历名称、姓名；工作经历的公司名称、职位名称、开始时间；项目经历的项目名称、开始时间；教育经历的学校名称。",
    "- 不要编造用户没提供的公司、学校、时间、数字成果；信息不够时在 reply 里向用户提问，resume 返回 null。",
    ...(hasMaterials
      ? [
          "- 补充材料是用户提供的原始资料，用来补全简历中的空缺（时间、职责、数字成果、技能等）；材料与简历冲突时以材料为准，并在 reply 里说明改了哪里。",
          "- 只取与求职相关的事实，不要把材料里的无关内容塞进简历，也不要照抄整段原文。",
          "- 用户消息里的链接已经抓取为材料，直接按材料内容处理，不要回答「无法访问链接」。",
        ]
      : []),
    "- 用户只要求改某一部分时，其他部分保持原样。",
    "- 文字面向招聘方：动词开头、突出职责和可量化成果，分点内容用换行分隔。",
    "",
    "只输出一个 json 对象，格式：",
    '{"reply": "用中文简要说明改了什么，或回答用户的问题", "resume": 修改后的完整简历对象（结构与上面相同），不需要修改时为 null}',
  ].join("\n");
}

export interface AiAskOptions {
  /** 用户导入的补充材料，随本次请求一起送给模型。 */
  materials?: ResumeMaterial[];
  /** 当前用户消息附带的图片，使用 OpenAI 兼容的视觉输入格式。 */
  images?: AiImage[];
  signal?: AbortSignal;
}

function userContent(input: string, images: AiImage[]): ChatContent {
  if (!images.length) return input;
  return [
    { type: "text", text: input || "请结合这张图片处理我的简历请求。" },
    ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } })),
  ];
}

export async function askResumeAssistant(
  settings: AiSettings,
  resume: BossResumeDocument,
  history: AiTurn[],
  input: string,
  options: AiAskOptions = {},
): Promise<AiEditResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(resume, options.materials ?? []) },
    ...history.slice(-HISTORY_LIMIT),
    { role: "user", content: userContent(input, options.images ?? []) },
  ];
  const { text: rawText, json: raw } = await chatReply(settings, messages, { signal: options.signal });
  // 纯问答时模型常直接回一段文字而不套 json：当作回复展示，不改简历
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reply: normalizeAiText(rawText), changes: [] };
  const { reply, resume: patch } = raw as { reply?: unknown; resume?: unknown };
  const text = typeof reply === "string" && reply.trim() ? normalizeAiText(reply.trim()) : "";

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { reply: text || "这次没有修改简历。", changes: [] };
  }
  const next = applyAiResume(resume, patch as Record<string, unknown>);
  const changes = diffResumes(resume, next);
  return { reply: text || (changes.length ? "已按要求修改。" : "这次没有修改简历。"), resume: changes.length ? next : undefined, changes };
}

const SECTION_LABEL: Record<string, string> = {
  title: "基本资料",
  profile: "基本资料",
  professionalSkills: "专业技能",
  customModules: "自定义模块",
  advantage: "个人优势",
  jobIntent: "求职意向",
  workExperiences: "工作经历",
  projects: "项目经历",
  educations: "教育经历",
  certificates: "资格证书",
  socialProfiles: "社交主页",
  volunteerExperiences: "志愿者服务",
  jobSearchStatus: "求职状态",
};

/** 把字段级差异按模块汇总成「工作经历 · 3 处」。 */
export function summarizeChanges(changes: ResumeFieldDiff[]): string[] {
  const counts = new Map<string, number>();
  for (const change of changes) {
    const label = SECTION_LABEL[change.path.split(/[.[]/, 1)[0]] ?? "其他";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} · ${count} 处`);
}
