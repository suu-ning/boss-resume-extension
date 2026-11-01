<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from "vue";
import {
  copyResume,
  createBlankResume,
  type BossResumeDocument,
  type ResumeIndexItem,
  type OnlineSyncOptions,
  validateResume,
  describeIssue,
  createResumeFromBossImport,
  refreshResumeFromBossImport,
  type BossImportReport,
} from "./domain";
import { ResumeRepository } from "./repository";
import { fetchBossResume, listBossResumes, uploadBossResume } from "./boss/client";
import { buildUploadPlan, type BossUploadResult } from "./boss/uploadPlan";
import type { BossFetchError } from "./boss/types";
import StringList from "./components/StringList.vue";
import CustomModulesEditor from "./components/CustomModulesEditor.vue";
import ItemList from "./components/ItemList.vue";
import { EDUCATION, PROJECTS, WORK } from "./editor/itemSections";
import ResumePreview from "./components/ResumePreview.vue";
import AiChat from "./components/AiChat.vue";
import AiSettingsDialog from "./components/AiSettingsDialog.vue";
import { AiSettingsStore, DEFAULT_AI_SETTINGS, type AiSettings } from "./ai/settings";
import type { ResumeMaterial } from "./ai/materials";
import { syncAiOriginRule } from "./ai/originRule";
import { normalizeSectionOrder, type SectionId } from "./editor/sections";
import SectionNav from "./components/SectionNav.vue";
import DateRangeFields from "./components/DateRangeFields.vue";
import ToastHost from "./components/ToastHost.vue";
import RecordingDialog from "./components/RecordingDialog.vue";
import OnlineSyncDialog from "./components/OnlineSyncDialog.vue";
import { toast } from "./ui/toast";

type SaveState = "saved" | "saving" | "error" | "unsaved";

const repository = new ResumeRepository();
const resumes = ref<ResumeIndexItem[]>([]);
const current = ref<BossResumeDocument>();
const view = ref<"list" | "editor">("list");
const saveState = ref<SaveState>("saved");
/** 待确认删除的简历；undefined 表示未打开删除确认框。 */
const pendingRemoval = ref<{ localId: string; title: string }>();
const activeSection = ref<SectionId>("profile");
const professionalSkillsText = computed({
  get: () => current.value?.professionalSkills.join("\n") ?? "",
  set: (value: string) => {
    if (current.value) current.value.professionalSkills = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  },
});
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let suspendAutoSave = false;
let ignoreNextChange = false;
const BOSS_RESUME_URL = "https://cv.zhipin.com/my-resumes/";

const fetching = ref(false);
/** 读取进度：已处理 / 总数。 */
const fetchProgress = ref<{ done: number; total: number }>();
/** 刚从直聘简历导入的本地简历，在列表里高亮。 */
const importedResumeIds = ref<string[]>([]);
const showRecordingDialog = ref(false);
const showOnlineSync = ref(false);

/** 列出直聘简历（cv.zhipin.com/my-resumes/）里的全部简历，逐份读取并各存为一份本地简历。 */
async function startBossFetch(): Promise<void> {
  if (fetching.value) return;
  fetching.value = true;
  importedResumeIds.value = [];
  try {
    const outcome = await listBossResumes();
    if (!outcome.ok) {
      showFetchError(outcome.error);
      return;
    }
    const items = outcome.data.resumes;
    if (!items.length) {
      // 列表为空时不做删除对齐：接口格式变化也会读出空列表，宁可不删也不误删全部本地简历。
      showFetchError({ code: "NO_DATA", message: "直聘简历里还没有简历，请先在 cv.zhipin.com/my-resumes/ 新建一份" });
      return;
    }
    if (view.value === "editor") {
      await saveNow();
      goList();
    }
    // 先对齐删除：绑定的直聘简历已不在列表里时，已同步的本地简历一并删除；
    // 有本地修改的只解除绑定、保留内容，避免丢掉没上传的改动。
    // 其余已导入过的直聘简历（按 bossCvId）直接更新原来那条；有多条时更新最近修改的一条。
    const remoteIds = new Set(items.map((item) => item.cvId));
    const removed: string[] = [];
    const unbound: string[] = [];
    const boundByCvId = new Map<string, string>();
    for (const entry of await repository.list()) {
      const doc = await repository.get(entry.localId);
      if (!doc?.bossCvId) continue;
      if (!remoteIds.has(doc.bossCvId)) {
        if (doc.syncState === "synced") {
          await repository.remove(doc.localId);
          removed.push(doc.title);
        } else {
          delete doc.bossCvId;
          doc.syncState = "unbound";
          await repository.save(doc);
          unbound.push(doc.title);
        }
        continue;
      }
      if (!boundByCvId.has(doc.bossCvId)) boundByCvId.set(doc.bossCvId, doc.localId);
    }
    if (current.value && removed.length && !(await repository.get(current.value.localId))) current.value = undefined;
    const cleanup = removed.length || unbound.length ? { removed, unbound } : undefined;
    const reports: { cvName: string; updated: boolean; report: BossImportReport }[] = [];
    const failures: { cvName: string; message: string }[] = [];
    const ids: string[] = [];
    fetchProgress.value = { done: 0, total: items.length };
    // 逐份串行读取，避免同时向直聘发多个请求。
    for (const item of items) {
      try {
        const detail = await fetchBossResume(item.cvId);
        if (!detail.ok) failures.push({ cvName: item.cvName, message: detail.error.message });
        else {
          const boundId = boundByCvId.get(item.cvId);
          const existing = boundId ? await repository.get(boundId) : undefined;
          const resume = existing ? refreshResumeFromBossImport(existing, detail.result) : createResumeFromBossImport(detail.result);
          await repository.save(resume);
          ids.push(resume.localId);
          reports.push({ cvName: detail.result.cvName, updated: Boolean(existing), report: detail.result.report });
        }
      } catch (error) {
        failures.push({ cvName: item.cvName, message: error instanceof Error ? error.message : String(error) });
      }
      fetchProgress.value = { done: fetchProgress.value.done + 1, total: items.length };
    }
    await loadList();
    importedResumeIds.value = ids;
    showImportToast(reports, failures, cleanup);
  } catch (error) {
    showFetchError({ code: "PAGE_UNAVAILABLE", message: "读取失败，请重新加载扩展后重试", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    fetching.value = false;
    fetchProgress.value = undefined;
  }
}

/** 读取直聘简历失败：标题给结论，详情逐行展开。 */
function showFetchError(error: BossFetchError): void {
  toast({ title: error.message, tone: "error", lines: error.detail ? error.detail.split("\n") : [] });
}

/** 导入结束后汇总成一条提示：份数、每份读到了什么、以及被对齐删除 / 解除绑定的本地条目。 */
function showImportToast(
  reports: { cvName: string; updated: boolean; report: BossImportReport }[],
  failures: { cvName: string; message: string }[],
  cleanup?: { removed: string[]; unbound: string[] },
): void {
  if (cleanup?.removed.length) {
    toast({ title: `直聘简历里已删除，本地一并删除 ${cleanup.removed.length} 份`, tone: "info", lines: [cleanup.removed.join("、")] });
  }
  if (cleanup?.unbound.length) {
    toast({
      title: `直聘简历里已删除，本地保留 ${cleanup.unbound.length} 份并解除绑定`,
      tone: "info",
      lines: [cleanup.unbound.join("、"), "这些有未上传的修改，再点「上传」会在直聘新建一份"],
    });
  }
  if (!reports.length && !failures.length) return;
  const lines: string[] = [];
  for (const entry of reports) {
    const groups = entry.report.readGroups.length
      ? entry.report.readGroups.map((group) => `${group.label}${group.count > 1 ? ` ${group.count} 条` : ""}`).join("、")
      : "没有读取到内容";
    const missing = entry.report.missingGroups.length ? `；未读取到 ${entry.report.missingGroups.join("、")}` : "";
    lines.push(`${entry.cvName}（${entry.updated ? "已更新" : "新建"}）：${groups}${missing}`);
    lines.push(...entry.report.warnings);
  }
  for (const failure of failures) lines.push(`「${failure.cvName}」读取失败：${failure.message}`);
  const updated = reports.filter((entry) => entry.updated).length;
  const created = reports.length - updated;
  const title = reports.length
    ? `已从直聘简历导入 ${reports.length} 份${created ? `，新建 ${created} 份` : ""}${updated ? `，更新 ${updated} 份` : ""}${failures.length ? `，${failures.length} 份读取失败` : ""}`
    : "直聘简历都没有读取成功";
  toast({ title, tone: failures.length ? "error" : "ok", lines, actions: [{ label: "去直聘简历查看 ↗", href: BOSS_RESUME_URL }] });
}

/** 上传结果：成功给结果口径和直聘链接；失败给到哪一步，以及重试会覆盖哪一份。 */
function showUploadResult(result: BossUploadResult): void {
  if (result.ok) {
    toast({
      title: `已上传，${result.created ? "在直聘简历新建了一份" : "覆盖了直聘简历里的那份"}`,
      tone: "ok",
      lines: result.warnings,
      actions: [{ label: "去直聘简历查看 ↗", href: result.editUrl }],
    });
    return;
  }
  const lines = [...(result.error.detail ? [result.error.detail] : []), ...result.warnings];
  if (result.editUrl) {
    lines.push(result.created
      ? "失败前已经新建了简历，里面可能还留着模板示例内容；这份已绑定到本地，重新点「上传」会覆盖它。"
      : "直聘简历里那份可能只覆盖了一部分，重新点「上传」会继续覆盖它。");
  }
  toast({
    title: `已保存到本地，上传到 BOSS 失败${result.error.step ? `（${result.error.step}）` : ""}：${result.error.message}`,
    tone: "error",
    lines,
    actions: result.editUrl ? [{ label: "去直聘简历处理 ↗", href: result.editUrl }] : [],
  });
}

// ---------- 上传到 BOSS（已绑定的覆盖，未绑定的新建） ----------

const uploadingResume = ref(false);

/**
 * 上传结束后回写直聘绑定，保证「一份本地简历 ↔ 一份直聘简历」始终对得上。
 *
 * - 成功：记上传时间，状态置为「已同步」。
 * - 中途失败但直聘那边已经建出了简历（`cvId` 有值）：照样绑上，只把状态降为「本地已修改」。
 *   这样重试就是覆盖那份半成品，不会在直聘上多出一份重复简历、还白占份数。
 * 若该简历正在编辑器中打开，同步内存副本且不触发自动保存。
 */
async function markUploaded(localId: string, cvId: string, complete = true): Promise<void> {
  const stored = await repository.get(localId);
  if (!stored) return;
  stored.bossCvId = cvId;
  if (complete) stored.lastBossUploadedAt = new Date().toISOString();
  stored.syncState = complete ? "synced" : "local-dirty";
  await repository.save(stored);
  if (current.value?.localId === localId) {
    ignoreNextChange = true;
    current.value = { ...current.value, bossCvId: cvId, lastBossUploadedAt: stored.lastBossUploadedAt, syncState: stored.syncState };
  }
  await loadList();
}

/** 编辑页「上传」：先存本地，再直接上传到直聘简历（已绑定的覆盖，未绑定的新建），不弹确认框。 */
async function uploadCurrent(): Promise<void> {
  if (!current.value || uploadingResume.value) return;
  await saveNow();
  if (saveState.value !== "saved" || !current.value) return;
  const target = await repository.get(current.value.localId);
  if (!target) return;
  const plan = buildUploadPlan(structuredClone(target));
  const blockers = [...plan.blockers, ...validateResume(target).issues.map(describeIssue)];
  if (blockers.length) {
    toast({ title: "已保存到本地，但还不能上传到 BOSS", tone: "error", lines: ["先改好这些问题再上传：", ...blockers] });
    return;
  }
  uploadingResume.value = true;
  try {
    const result = await uploadBossResume(plan);
    showUploadResult(result);
    // 失败时只要直聘已经建出了简历，也绑上：重试会覆盖这份半成品，不再新建重复的一份。
    if (result.ok) await markUploaded(target.localId, result.cvId);
    else if (result.cvId) await markUploaded(target.localId, result.cvId, false);
  } catch (error) {
    showUploadResult({
      ok: false,
      error: { code: "NO_TAB", message: "上传失败，请重新加载扩展后重试", detail: error instanceof Error ? error.message : String(error) },
      warnings: [],
    });
  } finally {
    uploadingResume.value = false;
  }
}

/**
 * 在线简历快照：读到线上内容后立刻落盘，既是下次对比的基线，也是以后写入失败时的回滚依据。
 * 模块勾选与取舍开关也一起存，下次打开弹窗沿用上次的选择。
 *
 * 直接改内存副本再走 saveNow：这样不会用仓库里的旧版本覆盖掉用户还没自动保存的编辑。
 */
async function saveOnlineSnapshot(payload: { fetchedAt: string; raw: Record<string, unknown>; options: OnlineSyncOptions }): Promise<void> {
  if (!current.value) return;
  current.value.onlineFetchedAt = payload.fetchedAt;
  current.value.onlineSnapshot = { capturedAt: payload.fetchedAt, rawData: payload.raw };
  current.value.onlineSyncOptions = payload.options;
  await saveNow();
}

/** 编辑页左侧的编辑方式：表单（菜单 + 表单两段）或 AI 对话；右侧预览常驻。 */
const editorMode = ref<"edit" | "ai">("edit");
const aiStore = new AiSettingsStore();
const aiSettings = ref<AiSettings>({ ...DEFAULT_AI_SETTINGS });
const showAiSettings = ref(false);
/** AI 编辑时导入的补充材料。放在这里是因为切到「编辑」后 AiChat 会卸载，但材料不该丢。 */
const aiMaterials = ref<ResumeMaterial[]>([]);

async function saveAiSettings(settings: AiSettings): Promise<void> {
  await aiStore.save(settings);
  aiSettings.value = settings;
  showAiSettings.value = false;
  void syncAiOriginRule(settings.baseUrl);
}

/** AI 改完（或撤销）后整体替换当前简历，走正常的自动保存。 */
function applyAiResume(resume: BossResumeDocument): void {
  if (!current.value || current.value.localId !== resume.localId) return;
  current.value = resume;
}

/** 左侧菜单或预览里的「编辑」：切回表单并定位到对应模块。 */
function editSection(section: SectionId): void {
  activeSection.value = section;
  editorMode.value = "edit";
}

/** 校验问题路径的根字段 → 所在的编辑模块。 */
const ISSUE_SECTION: Record<string, SectionId> = {
  title: "profile",
  profile: "profile",
  jobIntent: "profile",
  workExperiences: "work",
  projects: "projects",
  educations: "education",
};

/** 各模块未通过校验的问题，用于左侧菜单标注。 */
const issuesBySection = computed(() => {
  const grouped: Partial<Record<SectionId, string[]>> = {};
  for (const issue of validationIssues.value) {
    const section = ISSUE_SECTION[issue.path.split(/[.[]/, 1)[0]];
    if (section) (grouped[section] ??= []).push(describeIssue(issue));
  }
  return grouped;
});

const sourceLabel: Record<BossResumeDocument["source"], string> = {
  "boss-import": "BOSS 导入",
  manual: "手动创建",
  copy: "复制",
};
const syncLabel: Record<BossResumeDocument["syncState"], string> = {
  unbound: "未绑定",
  synced: "已同步",
  "local-dirty": "本地已修改",
};

const saveText = computed(() => ({
  saved: "已保存到本地",
  saving: "正在保存…",
  error: "保存失败",
  unsaved: "等待自动保存",
})[saveState.value]);

const validationIssues = computed(() => current.value ? validateResume(current.value).issues : []);

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** 校验问题按「列表字段 → 条目下标」分组，供条目卡片显示「待完善」。路径形如 projects[2].startDate。 */
const issuesByItem = computed(() => {
  const grouped: Record<string, string[][]> = {};
  for (const issue of validationIssues.value) {
    const match = /^(\w+)\[(\d+)\]/.exec(issue.path);
    if (!match) continue;
    ((grouped[match[1]] ??= [])[Number(match[2])] ??= []).push(issue.message);
  }
  return grouped;
});

function itemIssues(key: string): (index: number) => string[] {
  return (index) => issuesByItem.value[key]?.[index] ?? [];
}

async function loadList(): Promise<void> {
  resumes.value = await repository.list();
}

async function openResume(id: string): Promise<void> {
  const resume = await repository.get(id);
  if (!resume) return;
  if (saveTimer) clearTimeout(saveTimer);
  suspendAutoSave = true;
  // 旧数据没有模块顺序；补齐成完整数组，左侧菜单直接拖动改写它。
  resume.sectionOrder = normalizeSectionOrder(resume.sectionOrder);
  // 旧版本没有专业技能和通用模块字段，打开时补齐后再进入编辑器。
  resume.professionalSkills ??= [];
  resume.customModules ??= [];
  current.value = resume;
  activeSection.value = "profile";
  editorMode.value = "edit";
  saveState.value = "saved";
  importedResumeIds.value = [];
  view.value = "editor";
  // 等待 deep watch 处理完这次整体替换，再恢复自动保存，避免“打开即视为编辑”。
  await nextTick();
  suspendAutoSave = false;
  hasUserEdits = false;
  await repository.saveSettings({ lastSelectedResumeId: id });
}

async function createResume(): Promise<void> {
  const resume = createBlankResume();
  await repository.save(resume);
  await loadList();
  await openResume(resume.localId);
}

async function duplicateResume(id = current.value?.localId): Promise<void> {
  if (!id) return;
  const source = await repository.get(id);
  if (!source) return;
  const copy = copyResume(source);
  await repository.save(copy);
  await loadList();
  await openResume(copy.localId);
}

function requestRemove(resume: { localId: string; title: string }): void {
  pendingRemoval.value = { localId: resume.localId, title: resume.title };
}

async function confirmRemove(): Promise<void> {
  const target = pendingRemoval.value;
  if (!target) return;
  try {
    if (current.value?.localId === target.localId) {
      // 删除正在编辑的简历：先停掉待执行的自动保存，避免删除后又被保存回来。
      if (saveTimer) clearTimeout(saveTimer);
      suspendAutoSave = true;
      current.value = undefined;
      view.value = "list";
      await nextTick();
      suspendAutoSave = false;
    }
    await repository.remove(target.localId);
    pendingRemoval.value = undefined;
    await loadList();
  } catch (error) {
    toast({ title: "删除失败", tone: "error", lines: [error instanceof Error ? error.message : "浏览器本地存储不可用，请稍后重试。"] });
  }
}

/** 只有用户真实编辑过才把“已同步”降级为“本地已修改”，单纯打开/离开不改变同步状态。 */
let hasUserEdits = false;

async function saveNow(): Promise<void> {
  if (!current.value) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveState.value = "saving";
  const document = structuredClone(toRaw(current.value));
  document.updatedAt = new Date().toISOString();
  if (hasUserEdits && document.syncState === "synced") document.syncState = "local-dirty";
  try {
    await repository.save(document);
    hasUserEdits = false;
    if (current.value?.localId === document.localId) {
      ignoreNextChange = true;
      current.value = document;
    }
    saveState.value = "saved";
    await loadList();
  } catch (error) {
    toast({ title: "保存到本地失败", tone: "error", lines: [error instanceof Error ? error.message : "浏览器本地存储不可用，请稍后重试。"] });
    saveState.value = "error";
  }
}

function scheduleSave(): void {
  if (ignoreNextChange) {
    ignoreNextChange = false;
    return;
  }
  if (!current.value || suspendAutoSave) return;
  hasUserEdits = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveState.value = "unsaved";
  saveTimer = setTimeout(() => void saveNow(), 800);
}

function goList(): void {
  if (saveState.value === "unsaved" || saveState.value === "error") void saveNow();
  view.value = "list";
}

watch(current, scheduleSave, { deep: true });
/** 换简历时清空补充材料：材料属于上一份简历的上下文。 */
watch(() => current.value?.localId, () => { aiMaterials.value = []; });
onMounted(() => {
  void loadList();
  void aiStore.load().then((settings) => {
    aiSettings.value = settings;
    // 浏览器重启后动态规则可能已被清掉，这里按已保存的接口地址补一次。
    void syncAiOriginRule(settings.baseUrl);
  });
});
onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
  void saveNow();
});
</script>

<template>
  <main class="app-shell">
    <header class="app-header">
      <button v-if="view === 'editor'" class="back-link" type="button" @click="goList">← 所有档案</button>
      <div class="brand" :class="{ 'brand--list': view === 'list' }">
        <span class="brand-mark" aria-hidden="true">R</span>
        <div><strong>求职档案</strong><small>LOCAL RESUME STUDIO</small></div>
      </div>
      <div v-if="view === 'editor'" class="header-actions">
        <span class="save-state" :class="`save-state--${saveState}`" aria-live="polite">{{ saveText }}</span>
        <button class="button button--quiet" type="button" @click="showRecordingDialog = true">附件同步调研</button>
        <button v-if="current" class="button button--quiet" type="button" @click="showOnlineSync = true">同步在线简历</button>
        <button class="button button--quiet" type="button" @click="duplicateResume()">复制</button>
        <button v-if="current" class="button button--quiet button--danger" type="button" @click="requestRemove(current)">删除</button>
        <button class="button button--accent" type="button" :disabled="saveState === 'saving' || uploadingResume" :title="current?.bossCvId ? '覆盖直聘简历里对应的那份' : '在直聘简历新建一份'" @click="uploadCurrent">{{ uploadingResume ? "正在上传到 BOSS…" : "上传" }}</button>
      </div>
    </header>

    <section v-if="view === 'list'" class="list-view" aria-labelledby="page-title">
      <div class="list-hero">
        <div><p class="eyebrow">YOUR LOCAL VERSIONS</p><h1 id="page-title">管理每一份<em>求职档案</em></h1><p>本地编辑，按你的节奏准备下一次机会。</p></div>
        <div class="hero-actions"><button class="button button--accent button--large" type="button" @click="createResume">+ 创建空白简历</button><button class="button button--outline" type="button" :disabled="fetching" @click="startBossFetch">{{ fetching ? (fetchProgress ? `正在读取 BOSS（${fetchProgress.done}/${fetchProgress.total}）…` : "正在读取 BOSS…") : "从 BOSS 获取" }}</button><button class="button button--quiet" type="button" @click="showRecordingDialog = true">附件同步调研</button><a class="button button--quiet" :href="BOSS_RESUME_URL" target="_blank" rel="noopener noreferrer">前往 BOSS 简历 ↗</a></div>
      </div>
      <div class="list-toolbar"><span>{{ resumes.length }} 份本地简历</span><span>不会自动上传 BOSS</span></div>
      <div v-if="resumes.length" class="resume-list" role="list">
        <article v-for="resume in resumes" :key="resume.localId" class="resume-row" :class="{ 'resume-row--imported': importedResumeIds.includes(resume.localId) }" role="listitem">
          <div class="resume-title"><span class="source-dot" :class="`source-dot--${resume.source}`"></span><div><h2>{{ resume.title || "未命名简历" }}</h2><p>{{ sourceLabel[resume.source] }}</p></div></div>
          <dl><div><dt>本地保存</dt><dd>{{ formatDate(resume.updatedAt) }}</dd></div><div><dt>BOSS 上传</dt><dd>{{ formatDate(resume.lastBossUploadedAt) }}</dd></div></dl>
          <span class="status-badge" :class="`status-badge--${resume.syncState}`">{{ syncLabel[resume.syncState] }}</span>
          <div class="row-actions"><button class="text-button" type="button" @click="duplicateResume(resume.localId)">复制</button><button class="text-button text-button--danger" type="button" :aria-label="`删除「${resume.title}」`" @click="requestRemove(resume)">删除</button><button class="button button--dark" type="button" @click="openResume(resume.localId)">编辑</button></div>
        </article>
      </div>
      <div v-else class="empty-state"><span aria-hidden="true">⌁</span><h2>从一张空白页开始</h2><p>创建本地简历后，可以随时编辑和复制不同版本。</p><button class="button button--accent" type="button" @click="createResume">创建空白简历</button></div>
    </section>

    <section v-else-if="current" class="editor-view" :class="`editor-view--${editorMode}`" aria-label="简历编辑器">
      <!-- 左侧：编辑模式下是「菜单 + 表单」两段，AI 模式下是对话框；右侧预览常驻 -->
      <div class="composer" data-item-sheet-host>
        <div class="mode-switch" role="tablist" aria-label="编辑方式">
          <button type="button" role="tab" :aria-selected="editorMode === 'edit'" :class="{ active: editorMode === 'edit' }" @click="editorMode = 'edit'">编辑</button>
          <button type="button" role="tab" :aria-selected="editorMode === 'ai'" :class="{ active: editorMode === 'ai' }" @click="editorMode = 'ai'">AI 编辑</button>
        </div>
        <div v-show="editorMode === 'edit'" class="composer-body">
          <aside class="editor-nav" aria-label="简历分组">
            <p class="eyebrow">RESUME EDITOR</p><h1>{{ current.title || "未命名简历" }}</h1>
            <SectionNav :order="current.sectionOrder as SectionId[]" :active="activeSection" :issues="issuesBySection" @select="editSection" />
          </aside>

          <div class="editor-content">
            <section v-if="activeSection === 'profile'" class="form-section"><div class="section-heading"><p class="eyebrow">CORE PROFILE</p><h2>基本资料</h2><p>这些信息用于识别你的职业身份。</p></div><div class="form-grid"><label class="field field--wide">简历名称<input v-model="current.title" maxlength="80" placeholder="例如：产品经理 · 增长方向" /></label><label class="field">姓名<input v-model="current.profile.name" maxlength="40" placeholder="你的姓名" /></label><label class="field">性别<select v-model="current.profile.gender"><option :value="undefined">未填写</option><option value="male">男</option><option value="female">女</option><option value="unknown">不便透露</option></select></label><label class="field">求职身份<input v-model="current.profile.jobIdentity" placeholder="例如：在职，考虑机会" /></label><label class="field">参加工作时间<input v-model="current.profile.workStartDate" type="month" /></label><label class="field">出生年月<input v-model="current.profile.birthDate" type="month" /></label><label class="field field--wide">头像链接<input v-model="current.profile.avatar" type="url" placeholder="https://" /></label></div><h3 class="form-subhead">求职意向</h3><div class="form-grid"><label class="field">工作类型<input v-model="current.jobIntent.jobType" placeholder="全职 / 实习 / 兼职" /></label><label class="field">薪资期望<input v-model="current.jobIntent.salary" placeholder="例如：25-35K·14薪" /></label><label class="field field--wide">求职偏好<textarea v-model="current.jobIntent.jobPreference" rows="3" placeholder="行业、团队或工作方式偏好" /></label></div><div class="chip-groups"><StringList label="期望城市" :items="current.jobIntent.cities" /><StringList label="期望职位" :items="current.jobIntent.positions" /><StringList label="目标行业" :items="current.jobIntent.industries" /></div></section>

            <section v-if="activeSection === 'professionalSkills'" class="form-section"><div class="section-heading"><p class="eyebrow">PROFESSIONAL SKILLS</p><h2>专业技能</h2><p>保留原简历中的技能描述，也可以按行整理技能要点。</p></div><label class="field field--wide"><span>技能描述</span><textarea v-model="professionalSkillsText" rows="10" maxlength="3000" placeholder="例如：熟练 TypeScript、JavaScript，熟悉 React 与状态管理…" /></label><p class="field-hint">每行会作为一条技能内容保存。</p></section>

            <section v-if="activeSection === 'customModules'" class="form-section"><CustomModulesEditor :modules="current.customModules" /></section>

            <section v-if="activeSection === 'advantage'" class="form-section"><div class="section-heading"><p class="eyebrow">ADVANTAGE</p><h2>个人优势</h2><p>用具体能力、经验和成果说明你的价值。</p></div><label class="field field--wide"><span class="visually-hidden">个人优势</span><textarea v-model="current.advantage" rows="10" maxlength="2000" placeholder="例如：5 年消费互联网产品经验，主导过从 0 到 1 的增长产品…" /></label><p class="field-hint">{{ current.advantage.length }}/2000。最终以 BOSS 服务端的字段限制为准。</p></section>


            <section v-if="activeSection === 'work'" class="form-section"><ItemList :items="current.workExperiences" v-bind="WORK" :issues-of="itemIssues('workExperiences')"><template #form="{ item }"><div class="form-grid"><label class="field"><span>公司名称 *</span><input v-model="item.companyName" /></label><label class="field"><span>职位名称 *</span><input v-model="item.positionName" /></label><label class="field"><span>所属行业</span><input v-model="item.industry" /></label><label class="field"><span>所属部门</span><input v-model="item.department" /></label><DateRangeFields v-model:start-date="item.startDate" v-model:end-date="item.endDate" v-model:is-current="item.isCurrent" start-required /><label class="field field--wide"><span>工作职责</span><textarea v-model="item.responsibilities" rows="6" /></label><label class="field field--wide"><span>工作成果</span><textarea v-model="item.achievements" rows="6" /></label></div><StringList label="技能" :items="item.skills" /></template></ItemList></section>

            <section v-if="activeSection === 'projects'" class="form-section"><ItemList :items="current.projects" v-bind="PROJECTS" :issues-of="itemIssues('projects')"><template #form="{ item }"><div class="form-grid"><label class="field"><span>项目名称 *</span><input v-model="item.projectName" /></label><label class="field"><span>担任角色</span><input v-model="item.role" /></label><DateRangeFields v-model:start-date="item.startDate" v-model:end-date="item.endDate" v-model:is-current="item.isCurrent" start-required /><label class="field field--wide"><span>项目描述</span><textarea v-model="item.description" rows="8" /></label><label class="field field--wide"><span>项目成果</span><textarea v-model="item.achievements" rows="6" /></label><label class="field field--wide"><span>项目链接</span><input v-model="item.link" type="url" placeholder="https://" /></label></div></template></ItemList></section>
            <section v-if="activeSection === 'education'" class="form-section"><ItemList :items="current.educations" v-bind="EDUCATION" :issues-of="itemIssues('educations')"><template #form="{ item }"><div class="form-grid"><label class="field"><span>学校名称 *</span><input v-model="item.schoolName" /></label><label class="field"><span>学历</span><input v-model="item.degree" placeholder="例如：本科 / 硕士" /></label><DateRangeFields v-model:start-date="item.startDate" v-model:end-date="item.endDate" v-model:is-current="item.isCurrent" /><label class="field"><span>专业</span><input v-model="item.major" /></label><label class="field field--wide"><span>在校经历</span><textarea v-model="item.campusExperience" rows="5" /></label><label class="field field--wide"><span>论文 / 研究课题</span><textarea v-model="item.thesis" rows="4" /></label></div></template></ItemList></section>

          </div>
        </div>
        <AiChat v-show="editorMode === 'ai'" v-model:materials="aiMaterials" :resume="current" :settings="aiSettings" @apply="applyAiResume" @open-settings="showAiSettings = true" />
      </div>
      <section class="preview-col" aria-label="简历预览">
        <ResumePreview :resume="current" @edit="editSection" />
      </section>
    </section>

    <AiSettingsDialog v-if="showAiSettings" :settings="aiSettings" @save="saveAiSettings" @close="showAiSettings = false" />
    <div v-if="pendingRemoval" class="dialog-backdrop" @click.self="pendingRemoval = undefined">
      <section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-title" aria-describedby="remove-desc">
        <button class="dialog-close" type="button" aria-label="关闭对话框" @click="pendingRemoval = undefined">×</button>
        <p class="eyebrow">DELETE LOCAL RESUME</p>
        <h2 id="remove-title">删除「{{ pendingRemoval.title }}」？</h2>
        <p id="remove-desc">只删除这份本地简历，BOSS 在线简历不受影响。删除后无法恢复。</p>
        <div class="dialog-actions">
          <button class="button button--quiet" type="button" autofocus @click="pendingRemoval = undefined">取消</button>
          <button class="button button--danger-solid" type="button" @click="confirmRemove">删除</button>
        </div>
      </section>
    </div>
    <RecordingDialog v-if="showRecordingDialog" @close="showRecordingDialog = false" />
    <OnlineSyncDialog v-if="showOnlineSync && current" :resume="current" @close="showOnlineSync = false" @snapshot="saveOnlineSnapshot" />
    <ToastHost />
  </main>
</template>

