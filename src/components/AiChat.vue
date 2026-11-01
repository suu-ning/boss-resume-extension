<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from "vue";
import { AiError } from "../ai/chatClient";
import { IMAGE_LIMITS, readImageFiles, type AiImage } from "../ai/images";
import { extractUrls, readLinkMaterial } from "../ai/linkMaterial";
import { MATERIAL_LIMITS, mergeMaterials, readMaterialFiles, totalMaterialChars, type ResumeMaterial } from "../ai/materials";
import { askResumeAssistant, summarizeChanges, type AiTurn } from "../ai/resumeAssistant";
import { isAiReady, type AiSettings } from "../ai/settings";
import type { BossResumeDocument } from "../domain/types";
import { toast } from "../ui/toast";

const props = defineProps<{ resume: BossResumeDocument; settings: AiSettings }>();
const emit = defineEmits<{ apply: [resume: BossResumeDocument]; openSettings: [] }>();

/** 补充材料放在父组件里，切到「编辑」再回来不会丢。 */
const materials = defineModel<ResumeMaterial[]>("materials", { default: () => [] });

interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  changes?: string[];
  images?: AiImage[];
  /** AI 改动前的简历，用于撤销这一轮。 */
  before?: BossResumeDocument;
  undone?: boolean;
}

const SUGGESTIONS = [
  "帮我润色整份简历，突出可量化成果",
  "根据下面的岗位 JD 优化简历：",
  "把工作经历改写成分点描述，动词开头",
  "写一段 300 字以内的个人优势",
];

const entries = ref<ChatEntry[]>([]);
const input = ref("");
const busy = ref(false);
/** 等待中的气泡文案：读链接时和等模型时不一样。 */
const progress = ref("");
const listEl = ref<HTMLElement>();
let controller: AbortController | undefined;
let seq = 0;

const ready = computed(() => isAiReady(props.settings));

/** structuredClone 不能直接复制嵌套 Vue 代理，先递归还原成普通对象。 */
function cloneResume(value: BossResumeDocument): BossResumeDocument {
  const seen = new WeakMap<object, unknown>();
  const unwrap = (input: unknown): unknown => {
    const raw = toRaw(input);
    if (!raw || typeof raw !== "object") return raw;
    if (seen.has(raw)) return seen.get(raw);
    if (Array.isArray(raw)) {
      const output: unknown[] = [];
      seen.set(raw, output);
      for (const item of raw) output.push(unwrap(item));
      return output;
    }
    const output: Record<string, unknown> = {};
    seen.set(raw, output);
    for (const [key, item] of Object.entries(raw)) output[key] = unwrap(item);
    return output;
  };
  return structuredClone(unwrap(value)) as BossResumeDocument;
}

// ---------- 补充材料：JD、旧简历、项目笔记等纯文本 ----------

const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const imageInput = ref<HTMLInputElement>();
const pendingImages = ref<AiImage[]>([]);
const materialChars = computed(() => totalMaterialChars(materials.value));

/** 文件夹选择靠非标准属性，模板里不写，挂载后再设，避免类型检查报未知属性。 */
onMounted(() => folderInput.value?.setAttribute("webkitdirectory", ""));

async function addMaterials(list: FileList | File[] | null): Promise<void> {
  if (!list || !list.length) return;
  const read = await readMaterialFiles(list);
  const merged = mergeMaterials(materials.value, read.materials);
  materials.value = merged.materials;
  if (read.skipped.length) {
    toast({
      title: `${read.skipped.length} 个文件没有导入`,
      tone: "error",
      lines: read.skipped.slice(0, 6).map((item) => `${item.name}：${item.reason}`),
    });
  }
  if (merged.dropped.length) {
    toast({
      title: `${merged.dropped.length} 个文件超出上限，未加入`,
      tone: "error",
      lines: [`最多 ${MATERIAL_LIMITS.files} 个文件、合计 ${MATERIAL_LIMITS.totalChars} 字。可以先移除不用的材料再导入。`, ...merged.dropped.slice(0, 6)],
    });
  }
  if (!read.skipped.length && !merged.dropped.length && read.materials.length) {
    toast({
      title: `已加入 ${read.materials.length} 个材料文件`,
      tone: "ok",
      lines: read.materials.filter((item) => item.truncated).map((item) => `${item.name}：内容过长，只送入前 ${MATERIAL_LIMITS.perFileChars} 字`),
    });
  }
}

async function onPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  await addMaterials(input.files);
  // 清空才能重复选同一个文件
  input.value = "";
}

function onDrop(event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  void addMaterials(files.filter((file) => !file.type.startsWith("image/")));
  void addImages(files.filter((file) => file.type.startsWith("image/")));
}

async function addImages(list: FileList | File[] | null): Promise<void> {
  if (!list || !list.length) return;
  const read = await readImageFiles(list);
  const room = Math.max(0, IMAGE_LIMITS.files - pendingImages.value.length);
  const accepted = read.images.slice(0, room);
  const skipped = [...read.skipped, ...read.images.slice(room).map((image) => ({ name: image.name, reason: `最多添加 ${IMAGE_LIMITS.files} 张图片` }))];
  pendingImages.value = [...pendingImages.value, ...accepted];
  if (skipped.length) {
    toast({ title: `${skipped.length} 张图片没有加入`, tone: "error", lines: skipped.slice(0, 6).map((item) => `${item.name}：${item.reason}`) });
  }
}

async function onImagePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  await addImages(input.files);
  input.value = "";
}

async function onPaste(event: ClipboardEvent): Promise<void> {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  await addImages(files);
}

function removeImage(id: string): void {
  pendingImages.value = pendingImages.value.filter((image) => image.id !== id);
}

function removeMaterial(id: string): void {
  materials.value = materials.value.filter((item) => item.id !== id);
}

function clearMaterials(): void {
  materials.value = [];
}

/** 切换到另一份简历时清空对话，避免把上一份的上下文带过去。 */
watch(() => props.resume.localId, () => {
  controller?.abort();
  entries.value = [];
});
onBeforeUnmount(() => controller?.abort());

function push(entry: Omit<ChatEntry, "id">): void {
  entries.value.push({ id: ++seq, ...entry });
  void nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: "smooth" }));
}

function history(): AiTurn[] {
  return entries.value
    .filter((entry): entry is ChatEntry & { role: AiTurn["role"] } => entry.role !== "error")
    .map(({ role, content, images }) => ({
      role,
      content: images?.length
        ? [{ type: "text" as const, text: content || "请结合这张图片处理我的简历请求。" }, ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
        : content,
    }));
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.host}${parsed.pathname}`;
    return path.length > 48 ? `${path.slice(0, 47)}…` : path;
  } catch {
    return url.length > 48 ? `${url.slice(0, 47)}…` : url;
  }
}

/**
 * 消息里带链接时，先把链接正文读成材料：模型本身不能上网，
 * 直接把链接丢给它，它只会说「无法访问」。
 */
async function readLinks(urls: string[]): Promise<void> {
  const added: ResumeMaterial[] = [];
  const failed: string[] = [];
  for (const [index, url] of urls.entries()) {
    progress.value = urls.length > 1 ? `正在读取链接（${index + 1}/${urls.length}）…` : "正在读取链接内容…";
    try {
      added.push(await readLinkMaterial(url));
    } catch (error) {
      failed.push(`${shortUrl(url)}：${error instanceof Error ? error.message : "读取失败"}`);
    }
  }
  if (added.length) {
    const merged = mergeMaterials(materials.value, added);
    materials.value = merged.materials;
    const kept = added.length - merged.dropped.length;
    toast({
      title: kept ? `已读取 ${kept} 个链接` : "链接没有加进材料",
      tone: "ok",
      lines: [
        ...added.filter((item) => !merged.dropped.includes(item.name)).map((item) => `${shortUrl(item.name)}：${item.chars} 字`),
        ...(merged.dropped.length ? [`另有 ${merged.dropped.length} 条超出材料上限（最多 ${MATERIAL_LIMITS.files} 份），先移除不用的材料再试`] : []),
      ],
    });
  }
  if (failed.length) {
    toast({
      title: `${failed.length} 个链接没有读取到内容`,
      tone: "error",
      lines: [...failed, "需要登录、或正文由脚本加载的页面可能读不到，可以打开链接把正文复制进来。"],
    });
  }
}

async function send(text = input.value): Promise<void> {
  const prompt = text.trim();
  const images = pendingImages.value.map((image) => ({ ...image }));
  if ((!prompt && !images.length) || busy.value || !ready.value) return;
  const past = history();
  push({ role: "user", content: prompt || "请结合图片处理我的简历请求。", images });
  input.value = "";
  pendingImages.value = [];
  busy.value = true;
  controller = new AbortController();
  let before: BossResumeDocument;
  const links = extractUrls(prompt);
  try {
    before = cloneResume(props.resume);
    if (links.length) await readLinks(links);
    progress.value = "AI 正在修改简历…";
    const result = await askResumeAssistant(props.settings, before, past, prompt, { images, materials: materials.value, signal: controller.signal });
    if (result.resume) {
      emit("apply", result.resume);
      push({ role: "assistant", content: result.reply, changes: summarizeChanges(result.changes), before });
    } else {
      push({ role: "assistant", content: result.reply });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") push({ role: "error", content: "已停止" });
    else push({ role: "error", content: error instanceof AiError ? error.message : "AI 请求失败，请重试" });
  } finally {
    busy.value = false;
    progress.value = "";
    controller = undefined;
  }
}

/** 撤销某一轮：回到那一轮之前的简历，之后各轮的改动一并失效。 */
function undo(entry: ChatEntry): void {
  if (!entry.before || busy.value) return;
  emit("apply", cloneResume(entry.before));
  const index = entries.value.indexOf(entry);
  for (const later of entries.value.slice(index)) if (later.before) later.undone = true;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

function useSuggestion(text: string): void {
  if (text.endsWith("：")) input.value = `${text}\n`;
  else void send(text);
}
</script>

<template>
  <section class="ai-chat" aria-label="AI 编辑简历" @dragover.prevent @drop.prevent="onDrop">
    <header class="ai-chat-head">
      <div>
        <h2>AI 编辑</h2>
        <p>说明要求，AI 直接改整份简历，每轮可撤销。</p>
      </div>
      <button class="button button--quiet" type="button" @click="emit('openSettings')">{{ ready ? settings.model : "未配置" }} · 设置</button>
    </header>

    <section class="ai-materials" aria-label="补充材料">
      <div class="ai-materials-head">
        <strong>补充材料</strong>
        <span class="ai-materials-hint">
          {{ materials.length ? `${materials.length} 个文件 · ${materialChars} 字` : "JD、旧简历、项目笔记，可拖入或粘贴链接" }}
        </span>
        <span class="ai-materials-actions">
          <button class="text-button" type="button" :disabled="busy" @click="fileInput?.click()">添加文件</button>
          <button class="text-button" type="button" :disabled="busy" @click="folderInput?.click()">添加文件夹</button>
          <button v-if="materials.length" class="text-button text-button--danger" type="button" :disabled="busy" @click="clearMaterials">清空</button>
        </span>
      </div>
      <ul v-if="materials.length" class="ai-materials-list">
        <li v-for="item in materials" :key="item.id" class="ai-material" :title="item.name">
          <span class="ai-material__name">{{ item.name }}</span>
          <span class="ai-material__size">{{ item.chars }} 字</span>
          <button class="ai-material__remove" type="button" :aria-label="`移除 ${item.name}`" @click="removeMaterial(item.id)">×</button>
        </li>
      </ul>
      <input ref="fileInput" type="file" multiple hidden accept=".txt,.text,.md,.markdown,.json,.jsonl,.csv,.tsv,.html,.htm,.xml,.yml,.yaml,.log" @change="onPicked" />
      <input ref="folderInput" type="file" multiple hidden @change="onPicked" />
    </section>

    <div v-if="!ready" class="ai-empty">
      <p>还没有配置 AI 接口。填写 DeepSeek 的 API Key 后即可使用。</p>
      <button class="button button--accent" type="button" @click="emit('openSettings')">去配置</button>
    </div>

    <template v-else>
      <div ref="listEl" class="ai-messages" aria-live="polite">
        <div v-if="!entries.length" class="ai-empty">
          <p>可以试试：</p>
          <div class="ai-suggestions">
            <button v-for="text in SUGGESTIONS" :key="text" class="ai-suggestion" type="button" @click="useSuggestion(text)">{{ text }}</button>
          </div>
        </div>
        <div v-for="entry in entries" :key="entry.id" class="ai-msg" :class="`ai-msg--${entry.role}`">
          <div v-if="entry.images?.length" class="ai-msg-images">
            <img v-for="image in entry.images" :key="image.id" :src="image.dataUrl" :alt="image.name" />
          </div>
          <p>{{ entry.content }}</p>
          <div v-if="entry.changes?.length" class="ai-changes">
            <span v-for="change in entry.changes" :key="change" class="ai-change">{{ change }}</span>
            <span v-if="entry.undone" class="ai-undone">已撤销</span>
            <button v-else class="ai-undo" type="button" :disabled="busy" @click="undo(entry)">撤销这次修改</button>
          </div>
        </div>
        <div v-if="busy" class="ai-msg ai-msg--assistant ai-msg--pending"><p>{{ progress || "AI 正在修改简历…" }}</p></div>
      </div>

      <form class="ai-input" @submit.prevent="send()">
        <div class="ai-input-main">
          <div v-if="pendingImages.length" class="ai-image-list" aria-label="待发送图片">
            <div v-for="image in pendingImages" :key="image.id" class="ai-image-chip">
              <img :src="image.dataUrl" :alt="image.name" />
              <span :title="image.name">{{ image.name }}</span>
              <button type="button" :aria-label="`移除 ${image.name}`" :disabled="busy" @click="removeImage(image.id)">×</button>
            </div>
          </div>
          <textarea v-model="input" rows="2" placeholder="输入要求，也可以粘贴、拖入图片……（Enter 发送，Shift+Enter 换行）" :disabled="busy" @keydown="onKeydown" @paste="onPaste" />
        </div>
        <button class="button button--quiet ai-image-button" type="button" :disabled="busy" aria-label="添加图片" title="添加图片" @click="imageInput?.click()">图片</button>
        <input ref="imageInput" type="file" multiple hidden accept="image/*" @change="onImagePicked" />
        <button v-if="busy" class="button button--outline" type="button" @click="controller?.abort()">停止</button>
        <button v-else class="button button--accent" type="submit" :disabled="!input.trim() && !pendingImages.length">发送</button>
      </form>
    </template>
  </section>
</template>
