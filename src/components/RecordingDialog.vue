<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { attachRecording, getRecordingStatus, startRecording, stopRecording } from "../boss/client";
import { MAX_RECORDED_REQUESTS, type RecordingSample, type RecordingTabs } from "../boss/recording";

const emit = defineEmits<{ close: [] }>();

const recording = ref(false);
const busy = ref(false);
const attaching = ref(false);
const count = ref(0);
const tabs = ref<RecordingTabs>();
const sample = ref<RecordingSample>();
const error = ref("");
let statusTimer: ReturnType<typeof setInterval> | undefined;

/** 有没有 BOSS 页面接上；接不上时计数永远是 0，必须显式提示，不能让人对着 0 猜。 */
const linkState = computed<"none" | "partial" | "ok">(() => {
  const value = tabs.value;
  if (!value) return "ok";
  if (value.alive === 0) return "none";
  return value.alive < value.matched ? "partial" : "ok";
});

const linkText = computed<string>(() => {
  const value = tabs.value;
  if (!value) return "";
  if (value.matched === 0) return "没有找到已打开的 BOSS 页面";
  if (value.alive === 0) return `找到 ${value.matched} 个 BOSS 页面，但录制脚本一个都没接上`;
  if (value.alive < value.matched) return `已接上 ${value.alive} / ${value.matched} 个 BOSS 页面，其余没有响应`;
  return `已接上 ${value.alive} 个 BOSS 页面，操作后计数会增长`;
});

function applyStatus(status: { recording: boolean; count: number; tabs?: RecordingTabs }): void {
  recording.value = status.recording;
  count.value = status.count;
  if (status.tabs) tabs.value = status.tabs;
}

onMounted(() => {
  void getRecordingStatus().then(applyStatus).catch((reason: unknown) => {
    error.value = reason instanceof Error ? reason.message : "读取录制状态失败";
  });
  statusTimer = setInterval(() => {
    if (!recording.value || busy.value) return;
    void getRecordingStatus().then(applyStatus).catch(() => undefined);
  }, 1000);
});

onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer);
});

async function begin(): Promise<void> {
  busy.value = true;
  error.value = "";
  sample.value = undefined;
  try {
    applyStatus(await startRecording());
    if (tabs.value && tabs.value.alive === 0) {
      error.value = tabs.value.matched === 0
        ? "开始录制了，但没有打开 BOSS 页面。先打开 www.zhipin.com 再操作，回来后计数才有内容。"
        : tabs.value.failed[0] ?? "录制脚本没能接上 BOSS 页面，请刷新该页面后点「重新连接」。";
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "启动录制失败";
  } finally {
    busy.value = false;
  }
}

/** 重新注入录制脚本：扩展重载后旧脚本会静默失效，这是不刷新页面也能救回来的唯一办法。 */
async function attach(): Promise<void> {
  attaching.value = true;
  error.value = "";
  try {
    tabs.value = await attachRecording();
    if (tabs.value.alive === 0) {
      error.value = tabs.value.failed[0] ?? "没有 BOSS 页面可以接上，请先打开 www.zhipin.com 并刷新一次";
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "重新连接失败";
  } finally {
    attaching.value = false;
  }
}

async function finish(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    sample.value = (await stopRecording()) ?? undefined;
    recording.value = false;
    count.value = sample.value?.requests.length ?? count.value;
    if (!sample.value) error.value = "没有取得录制样本，请重新开始后再操作 BOSS 页面";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "结束录制失败";
  } finally {
    busy.value = false;
  }
}

function downloadSample(): void {
  if (!sample.value) return;
  const blob = new Blob([JSON.stringify(sample.value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `boss-attachment-sync-sample-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="!recording && !busy && emit('close')">
    <section class="dialog recording-dialog" role="dialog" aria-modal="true" aria-labelledby="recording-title">
      <button v-if="!recording && !busy" class="dialog-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
      <p class="eyebrow">BOSS REQUEST INSPECTOR</p>
      <h2 id="recording-title">附件同步调研</h2>
      <p class="recording-dialog__intro">录制期间，在 BOSS 页面手动操作附件简历。此工具只观察请求，不会上传、修改或删除简历。</p>

      <ol class="recording-steps">
        <li>先在另一个标签页打开已登录的 BOSS 页面（www.zhipin.com），再点「开始录制」。</li>
        <li>正常操作要调研的功能：编辑在线简历并保存、新增或删除条目、预览附件简历等。</li>
        <li>回来确认下面的计数在涨，再结束录制并下载脱敏样本。</li>
      </ol>

      <div class="recording-status" :class="{ 'recording-status--active': recording }" aria-live="polite">
        <span class="recording-status__dot" />
        <span>{{ recording ? "正在录制 BOSS 页面请求" : "当前未录制" }}</span>
        <strong>{{ count }} / {{ MAX_RECORDED_REQUESTS }}</strong>
      </div>

      <div v-if="tabs" class="recording-link" :class="`recording-link--${linkState}`">
        <p class="recording-link__text">
          {{ linkText }}
          <template v-if="linkState === 'none' && tabs.matched > 0">扩展重载后页面里的旧脚本会失效，点「重新连接」即可恢复，不用刷新。</template>
        </p>
        <ul v-if="tabs.failed.length" class="recording-link__failed">
          <li v-for="item in tabs.failed" :key="item">{{ item }}</li>
        </ul>
        <button v-if="linkState !== 'ok' || !recording" class="button button--outline recording-link__action" type="button" :disabled="attaching" @click="attach">
          {{ attaching ? "正在连接…" : "重新连接" }}
        </button>
      </div>

      <p class="recording-privacy">导出文件不包含原始字段值、Cookie 或 token 值；只保留字段名、数据结构以及值的类型/长度。分享前仍请检查样本。</p>
      <p v-if="error" class="recording-error" role="alert">{{ error }}</p>

      <div class="dialog-actions">
        <button v-if="!recording" class="button button--quiet" type="button" :disabled="busy" @click="emit('close')">关闭</button>
        <button v-if="!recording" class="button button--accent" type="button" :disabled="busy" @click="begin">{{ busy ? "正在启动…" : "开始录制" }}</button>
        <button v-else class="button button--danger-solid" type="button" :disabled="busy" @click="finish">{{ busy ? "正在结束…" : "结束录制" }}</button>
        <button v-if="sample && !recording" class="button button--outline" type="button" @click="downloadSample">下载脱敏样本</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.recording-dialog__intro { margin-bottom: 18px; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.recording-steps { display: grid; gap: 8px; margin: 0; padding-left: 22px; color: var(--text-2); font-size: 13px; line-height: 1.55; }
.recording-status { display: flex; align-items: center; gap: 9px; margin-top: 22px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text-2); background: var(--surface-soft); font-size: 13px; }
.recording-status strong { margin-left: auto; color: var(--text); font-variant-numeric: tabular-nums; }
.recording-status__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.recording-status--active { border-color: #f1c4c0; color: #a82e28; background: var(--danger-soft); }
.recording-status--active .recording-status__dot { background: var(--danger); box-shadow: 0 0 0 3px rgba(217, 68, 58, .14); }
.recording-link { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 12px; line-height: 1.55; background: var(--surface-soft); }
.recording-link__text { margin: 0; color: var(--text-2); }
.recording-link--ok { border-color: #bfe0cd; background: var(--ok-soft); }
.recording-link--ok .recording-link__text { color: var(--ok); }
.recording-link--partial { border-color: #e8d3ac; background: #fdf7ec; }
.recording-link--partial .recording-link__text { color: #8a6320; }
.recording-link__failed { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
.recording-link__action { margin-top: 8px; }
.recording-privacy { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.recording-error { margin: 12px 0 0; color: var(--danger); font-size: 13px; }
</style>
