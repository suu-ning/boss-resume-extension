# BOSS 简历浏览器扩展

基于 Manifest V3、Vue 3、TypeScript 和 Vite 的本地简历管理扩展。

## 已实现

- 使用 `chrome.storage.local` 保存多个本地 BOSS 简历版本。
- 创建、复制、编辑和 800ms 防抖自动保存。
- 覆盖基本信息、个人优势、求职期望、工作/项目/教育经历、证书、社交主页、志愿服务、求职状态。
- 提供领域模型、字段校验和字段级差异计算。
- 扩展图标打开独立编辑页。
- 上传到 BOSS：在直聘简历新建一份简历并填入本地内容，不覆盖已有简历。
- 同步到在线简历：读出 BOSS 在线简历并逐模块比对，列出要新增 / 更新 / 删除 / 清空的内容，可按模块勾选本次范围并写入，写完回读校验残差。

## AI 图片输入

AI 编辑支持通过“图片”按钮选择图片，也支持把截图直接粘贴或拖入输入框。图片会按 OpenAI 兼容接口的 `image_url` 格式发送，并保留在本轮对话上下文中；单张不超过 6MB，每次最多 4 张。

图片识别需要你配置的模型支持视觉输入。官方 DeepSeek 常用文本模型通常不能识图，需要改用支持视觉的模型或兼容 OpenAI 图片格式的中转接口。

## 本地开发

```bash
npm install
npm run build
npm test
```

构建产物位于 `dist/`。

## 加载扩展

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目的 `dist/` 目录。

## 从 BOSS 获取（只读，来源：直聘简历）

1. 在同一浏览器中登录 BOSS 求职者账号。
2. 在扩展页点击“从 BOSS 获取”，在弹出的列表里选一份直聘简历。

实现方式（`src/background/serviceWorker.ts#runInCvPage`）：优先使用已打开的 `cv.zhipin.com` 标签，没有就后台临时打开 `cv.zhipin.com/my-resumes/`，读完关闭。在页面主世界先注入 `src/boss/cvPageApi.ts`（请求头、traceId、错误码，读取与上传共用），再执行 `src/boss/pageFetch.ts`：

1. `myresume/querylist.json`：列出全部简历（名称、样式模板、更新时间）供选择。
2. `myresume/query.json`（参数 `cvId`）：读取选中简历的详情，由 `src/boss/resumeAdapter.ts` 按录制到的真实字段名转换。

只读，不写任何数据。本地简历会记下来源 `bossCvId` 和样式模板 `bossTemplateId`；上传时沿用这个模板，所以拉取后再上传，样式不变。复制出的副本解除 `bossCvId` 绑定，保留模板。

字段映射：`profileVO` 的姓名、性别（1 男 / 0 女）、出生年月、参加工作时间、期望城市与职位、薪资、求职状态；个人优势；工作、项目、教育经历（教育只有年份，本地按 9 月入学、6 月毕业补月份）。没有映射的 `profileVO` 字段（如手机号）原样保存在 `unmappedFields`。

错误码（`37` 登录失效、`121/122` 安全拦截、`9` 限流）参考开源项目 jackwener/boss-cli。失败时不自动重试。

## 上传到 BOSS（直聘简历）

上传是新增操作：在 `cv.zhipin.com` 的直聘简历里新建一份简历并填入本地内容，不修改、不覆盖已有简历，也不改 BOSS 在线简历。

流程（`src/background/serviceWorker.ts#uploadResume` 后台打开 `cv.zhipin.com/my-resumes/`，在页面主世界执行 `src/boss/pageUpload.ts`）：

1. `myresume/querylist.json`：已有份数 ≥ `maxCount` 时直接报“份数已满”，不新建。
2. 样式模板：本地简历记下的 `bossTemplateId` 优先；没有时取 `querylist.json` 里最近编辑过的那份简历的样式模板 `templateId`（没有已有简历时用直聘默认模板 `7d133318365793281g~~`）→ `myresume/syncfrombosszp.json` 按该样式新建，得到 `cvId` → `myresume/query.json` 读初始内容。
3. `updatecvname` → `profile/save` → `advantage/save` → `workexp` / `projectexp` / `eduexp` 的 `save`：先覆盖模板自带的条目，不够的新增（`id` 为空），多余的调 `delete.json` 删除。
4. 再读一次 `query.json`，条数或姓名不一致时提示用户核对。

请求格式照搬直聘简历编辑器：`application/x-www-form-urlencoded`，数组展开为 `key[i]`；请求头 `x-requested-with`、`traceId`（复刻页面算法）、`zp_token`（取自 `bst` Cookie）。每次写操作间隔 300ms，失败立即停止、不重试；失败前已新建的简历会给出链接，方便去直聘简历处理。

字段转换（`src/boss/uploadPlan.ts`）：性别 男 1 / 女 0 / 未填 -1；学历码 209 初中及以下、208 中专/中技、206 高中、202 大专、203 本科、204 硕士、205 博士；“至今”为 `endDate=0`；城市、职位按名称查直聘简历字典（城市只匹配市级），查不到时提示。手机号、邮箱、微信、头像沿用 BOSS 账号里的值。资格证书、社交主页、志愿者、期望行业、求职状态暂不上传，确认弹窗会列出来。

依据：保存接口来自 2026-10-28 的真实录制；新增条目与 `delete.json` 的用法来自直聘简历前端包，未经录制验证。

## 同步到在线简历

编辑页右上角「同步在线简历」打开差异预览：以当前档案为源，读出 BOSS 在线简历（`www.zhipin.com`）后逐模块对比，列出**要新增、要更新、要删除、要清空**的内容，勾选模块后可直接写入。

- 读取：`GET /wapi/zpgeek/resume/geek/preview/data.json`（2026-10-30 录制确认），一次返回 `baseInfo`、`userDesc`、`professionalSkill`、`expectList`、`workExpList`、`projectExpList`、`educationExpList`、`certificationList`。
- 适配与比对：`src/boss/online/adapter.ts`（字段名只在这里出现）、`src/boss/online/plan.ts`（纯函数，可单测）、`src/boss/online/normalize.ts`（文本/月份归一化）。
- 页面侧：`src/boss/online/pageRead.ts` 读、`pageDict.ts` 读字典、`pageWrite.ts` 写，都在页面主世界执行，复用 `cvPageApi` 的请求工具（额外支持 `extraHeaders`，用于 `www.zhipin.com` 的 `token` 头）。
- 每次读到线上内容都会存一份 `onlineSnapshot` 到本地档案，作为下次对比的基线与将来回滚的依据；模块勾选与开关存在 `onlineSyncOptions`。

比对口径（决定了什么算「一致」）：

- **按模块多选同步**：每个模块前有勾选框，只有勾选的模块会写入；没勾的模块线上原样保留、不计入汇总，也不参与阻断（例如不勾「基本资料」时，姓名为空不会挡住其他模块）。提供「全选 / 全不选 / 只选有差异的」三个快捷操作，选择随档案保存，下次打开沿用。`modules` 缺省（旧档案）视为全选，空数组表示一个都不选。
- 列表**按内容配对**，不按位置：BOSS 在线简历的顺序由服务端排（项目经历按开始时间倒序，实测与档案顺序不同），按下标对齐会把两条不相干的经历配成一条。配对先看「名称 + 开始时间」，再退到只看名称，两侧都只在唯一命中时才配，剩下的才按顺序补（多出的算新增 / 删除）。因此**条目顺序不同不再算差异**，写入也只会改内容对应的那一条（`ItemChange.localIndex` / `remoteIndex` 记录真实下标）。
- 线上多出的条目 → 删除；线上有值、本地为空 → 写空。
- 文本有**两套口径**：写入用 `multiline()`（保留换行，长文本按段落提交，否则 BOSS 预览页会把整段挤成一坨）；比对用 `plain()`（把换行、连续空白和线上的 `<br>` / `<p>` 都压成单个空格）。比对故意偏宽松——线上即使被服务端抹平了换行，也不会被判成差异而反复重写。
- 明确保留线上原值：手机号、邮箱、微信号、头像、学历与工作年限、工作经历的所属行业（线上是字典编码）、求职状态（本地没有 `applyStatus` 编码）。
- 开关：**期望行业**（默认关）。打开后按 BOSS 行业字典转码写入 `industryCodes`，转不了码就保留线上原值。
- 不比对：社交主页、志愿者服务、荣誉、社团、培训/岗位经历（接口结构未录制）、自定义模块（来自直聘简历）、求职身份与求职偏好。
- 项目「担任角色」是**自由文本**，不是字典：网页端（`www.zhipin.com` 项目经历编辑页）就是输入框，校验只有「2-12 个字」，读接口回的也是同一段文字。所以按文字比、按文字写，不需要任何编码对照表。（早期误判成字典编码，是因为脱敏样本把 1-3 位纯数字原样保留，`<digits:343>` 其实是录制时随手敲的测试值。）两个例外：本地为空 → 不清线上（角色是可选项）；本地超过 12 字 → 不写、保留线上值，模块标题挂「角色超长未写」（页面校验会直接拒掉，硬写会拖挂整轮同步）。
- 技能标签按**标签集合**比较：线上存成 `["React, TypeScript"]` 这样的单串，与本地 `["React", "TypeScript"]` 视为一致，避免反复重写同一段工作经历。

写入（`src/boss/online/execute.ts` 纯函数 + `contract.ts` 接口契约）：

- 点「同步写入」会**先读一次 BOSS 的职位 / 行业 / 城市字典**，把本地文字转成接口要的编码，再把要做的事逐条列出来，确认后才写。
- 写入顺序：基本资料 → 个人优势 → 期望 / 工作 / 项目 / 教育 → 资格证书。每条之间留 350ms 间隔，避免连续保存触发限流。
- 每条保存前先走录制到的 `precheck`；前置校验返回 `dialog` 非空时**放弃这一条**，不当作成功。
- 登录失效 / 安全校验 / 限流会立即停下，剩下的标成「未执行」；其他业务错误只记这一条并继续。
- 写完**立刻回读整份在线简历**重新比对，剩下的差异就是这次没做到的部分，不会只凭接口 `code: 0` 就报成功。

能力边界（写不了的一律显式列在「不做」里，不猜接口）：

| 模块 | 新增 | 更新 | 删除 |
|---|---|---|---|
| 基本资料 / 个人优势 | — | ✅ | — |
| 工作经历 | ✅ 需字典 | ✅ | ✅ |
| 项目经历 | ✅（`roleName` 编码无法解析） | ✅ | ✅ |
| 教育经历 | ❌ 需要学校 / 学历编码 | ✅ | ❌ 未录制删除接口 |
| 求职期望 | ✅ 需城市 + 职位编码 | ✅ | ❌ 删除按 `positionType` 整组删，无法只删一条 |
| 资格证书 | ✅ | ✅ | ✅ 整模块覆盖 |
| 专业技能 | — | ✅ 提交 `{skill}` 整段文本（走「手工编辑技能」这条契约，不需要 `parserId`） | — |

### 录制 BOSS 页面请求（附件同步调研）

在扩展档案列表点击“附件同步调研”并开始录制，然后切换到已登录的 BOSS 页面，手动操作附件简历预览或在线同步。回到扩展页结束录制并下载脱敏样本。此功能只观察页面请求，不会上传、修改或删除简历。

- 开始录制时会把 `content/networkCapture.js`（MAIN）与 `content/captureBridge.js`（ISOLATED）**重新注入到所有已打开的 BOSS 标签**，因此不需要手动刷新页面。扩展重载后旧内容脚本的 `chrome.runtime` 已失效（既不转发记录也收不到广播），界面会显示「已接上 N / M 个 BOSS 页面」，接不上时点「重新连接」即可恢复。
- 注入后靠 `boss.record.ping` 探活才能确认页面那头真的还在录：有回话才算接上，避免出现「状态灯在录、计数一直是 0」的假象。

- `content/networkCapture.ts`（MAIN）只在录制开启时观察页面自己发出的 zhipin.com 请求；请求与响应值经 `boss/recording.ts#sanitizeRecord` 转换成结构样本后写入 `chrome.storage.session`。结束录制后会清空会话数据。
- 样本保留接口路径、方法、状态码、字段名与结构；不保留 Cookie/token 值或请求/响应正文。所有字符串值仅表示类型/长度，短枚举数字除外。分享前仍建议自行检查下载文件。
- 脱敏规则：字符串只留长度；日期、手机号这类数字串只留格式（`9999.99`）；1–3 位数字、0–999 的整数和布尔值保留原值（用作枚举）；路径里像 ID 的段替换为 `{id}`；请求头只留名字；接口返回的 `code` 保留，`message` 只保留长度。

## 发布（打 tag 自动构建插件包）

`.github/workflows/release.yml` 在推送 `v*` 标签时自动跑 `npm ci` → `npm test` → `npm run build`，把 `dist/` 打成 `boss-resume-extension-<tag>.zip`（`manifest.json` 在 zip 根目录），挂到对应 Release 上并自动生成 release notes；同时上传一份 Actions artifact。

```bash
npm version patch   # 或手动改 package.json / public/manifest.json 的 version
git tag v0.3.0
git push origin v0.3.0
```

下载 zip 解压后，在扩展管理页「加载已解压的扩展程序」里选择解压出的目录即可。`workflow_dispatch` 手动触发只产出 artifact，不发布 Release。

