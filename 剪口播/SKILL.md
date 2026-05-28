---
name: videocut:剪口播
description: 口播视频转录和口误识别。生成审查稿和删除任务清单。触发词：剪口播、处理视频、识别口误
---

<!--
input: 视频文件 (*.mp4)
output: subtitles_words.json、auto_selected.json、review.html、video.mp4(符号链接)
pos: 转录+识别，到用户网页审核为止

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. /CLAUDE.md 路由表
-->

# 剪口播 v2

> 火山引擎转录 + AI 口误识别 + 网页审核

## 快速使用

```
用户: 帮我剪这个口播视频
用户: 处理一下这个视频
```

## 输出目录结构

```
output/
└── YYYY-MM-DD_视频名/
    ├── 剪口播/
    │   ├── 1_转录/
    │   │   ├── audio.mp3
    │   │   ├── volcengine_result.json
    │   │   └── subtitles_words.json
    │   ├── 2_分析/
    │   │   ├── readable.txt
    │   │   ├── auto_selected.json
    │   │   └── 口误分析.md
    │   └── 3_审核/
    │       ├── review.html
    │       └── video.mp4 → 源视频(符号链接)
    └── 字幕/
        └── ...
```

**规则**：已有文件夹则复用，否则新建。

## 流程

```
0. 创建输出目录
    ↓
1. 提取音频 (ffmpeg)
    ↓
2. 上传获取公网 URL (uguu.se)
    ↓
3. 火山引擎 API 转录
    ↓
4. 生成字级别字幕 (subtitles_words.json)
    ↓
5. AI 分析口误/静音，生成预选列表 (auto_selected.json)
    ↓
6. 生成审核网页 (review.html)
    ↓
7. 启动审核服务器，用户网页确认
    ↓
【等待用户确认】→ 网页点击「执行剪辑」或手动 /剪辑
```

## 执行步骤

### 步骤 0: 创建输出目录

```bash
# 变量设置（根据实际视频调整）
VIDEO_PATH="/path/to/视频.mp4"
VIDEO_NAME=$(basename "$VIDEO_PATH" .mp4)
DATE=$(date +%Y-%m-%d)
BASE_DIR="output/${DATE}_${VIDEO_NAME}/剪口播"

# 创建子目录
mkdir -p "$BASE_DIR/1_转录" "$BASE_DIR/2_分析" "$BASE_DIR/3_审核"
cd "$BASE_DIR"
```

### 步骤 1-3: 转录

```bash
cd 1_转录

# 1. 提取音频（文件名有冒号需加 file: 前缀）
ffmpeg -i "file:$VIDEO_PATH" -vn -acodec libmp3lame -y audio.mp3

# 2. 上传获取公网 URL
curl -s -F "files[]=@audio.mp3" https://uguu.se/upload
# 返回: {"success":true,"files":[{"url":"https://h.uguu.se/xxx.mp3"}]}

# 3. 调用火山引擎 API
SKILL_DIR="/Users/chengfeng/Desktop/AIos/剪辑Agent/.claude/skills/剪口播"
"$SKILL_DIR/scripts/volcengine_transcribe.sh" "https://h.uguu.se/xxx.mp3"
# 输出: volcengine_result.json
```

### 步骤 4: 生成字幕

```bash
node "$SKILL_DIR/scripts/generate_subtitles.js" volcengine_result.json
# 输出: subtitles_words.json

cd ..
```

### 步骤 5: 分析口误（脚本+AI）

#### 5.1 生成易读格式

```bash
cd 2_分析

node -e "
const data = require('../1_转录/subtitles_words.json');
let output = [];
data.forEach((w, i) => {
  if (w.isGap) {
    const dur = (w.end - w.start).toFixed(2);
    if (dur >= 0.2) output.push(i + '|[静' + dur + 's]|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  } else {
    output.push(i + '|' + w.text + '|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  }
});
require('fs').writeFileSync('readable.txt', output.join('\\n'));
"
```

#### 5.2 读取用户习惯

先读 `用户习惯/` 目录下所有规则文件。

#### 5.3 生成句子列表（关键步骤）

**必须先分句，再分析**。按静音切分成句子列表：

```bash
node -e "
const data = require('../1_转录/subtitles_words.json');
let sentences = [];
let curr = { text: '', startIdx: -1, endIdx: -1 };

data.forEach((w, i) => {
  const isLongGap = w.isGap && (w.end - w.start) >= 0.5;
  if (isLongGap) {
    if (curr.text.length > 0) sentences.push({...curr});
    curr = { text: '', startIdx: -1, endIdx: -1 };
  } else if (!w.isGap) {
    if (curr.startIdx === -1) curr.startIdx = i;
    curr.text += w.text;
    curr.endIdx = i;
  }
});
if (curr.text.length > 0) sentences.push(curr);

sentences.forEach((s, i) => {
  console.log(i + '|' + s.startIdx + '-' + s.endIdx + '|' + s.text);
});
" > sentences.txt
```

#### 5.4 脚本自动标记静音（必须先执行）

```bash
node -e "
const words = require('../1_转录/subtitles_words.json');
const selected = [];
words.forEach((w, i) => {
  if (w.isGap && (w.end - w.start) >= 0.2) selected.push(i);
});
require('fs').writeFileSync('auto_selected.json', JSON.stringify(selected, null, 2));
console.log('≥0.2s静音数量:', selected.length);
"
```

→ 输出 `auto_selected.json`（只含静音 idx）

#### 5.5 AI 分析口误（追加到 auto_selected.json）

> 🚨 **核心原则：删前保后。所有重复/口误，删前面的，保后面的。**

**按检测类型分工，多 Agent 并行执行**：

每个 Agent 只负责一种检测，prompt 更短更精确，避免规则互相干扰。

| Agent | 输入 | 检测内容 | 删除范围 |
|-------|------|----------|----------|
| A-句间重复 | sentences.txt | 相邻/隔一句开头≥5字相同 | 删**前句**整句 |
| B-句内重复 | sentences.txt | 同一句内 A+中间+A 模式 | 只删前面**片段**，不删整句 |
| C-残句 | sentences.txt | 话说一半+静音+后面重说 | 删残句**整句** |

**脚本可直接处理（不需要 AI）**：
- 卡顿词（那个那个、就是就是）→ 正则匹配
- 语气词（嗯、啊、呃）→ 标记待人工确认

**Agent prompt 模板**：

```
给每个 Agent 的 prompt 包含：
1. 只放该 Agent 对应的一条检测规则（从用户习惯/读取）
2. 完整的 sentences.txt 内容
3. 明确要求：返回要删除的 idx 范围列表
4. 🚨 强调"删前保后"：删前面的版本，保留后面更完整的版本
```

**Agent 返回格式**：

```
| 句号 | idx范围 | 类型 | 内容摘要 | 处理 |
|------|---------|------|----------|------|

删除idx列表: [所有要删除的idx]
```

**合并结果**：

```
收集所有 Agent 返回的 idx 列表 → 合并到 auto_selected.json → 去重排序
```

**范围整段删除规则**：标记口误时，从 startIdx 到 endIdx 之间的**所有元素**（含中间的 gap）全部加入 auto_selected。不要逐个挑选文字 idx 而跳过 gap。

🚨 **关键警告：行号 ≠ idx**

```
readable.txt 格式: idx|内容|时间
                   ↑ 用这个值

行号1500 → "1568|[静1.02s]|..."  ← idx是1568，不是1500！
```

**口误分析.md 格式：**

```markdown
## 句间重复 (Agent A)

| 句号 | idx范围 | 内容摘要 | 处理 |
|------|---------|----------|------|
| 5 | 212-233 | 与句6重复，句6更完整 | 删前句 |

## 句内重复 (Agent B)

| 句号 | idx范围 | 内容摘要 | 处理 |
|------|---------|----------|------|
| 16 | 492-510 | "很多人一提到CLI命令"前半重复 | 删片段 |

## 残句 (Agent C)

| 句号 | idx范围 | 内容摘要 | 处理 |
|------|---------|----------|------|
| 7 | 266-275 | "为了解释为了回答这个"未完成 | 删整句 |
```

### 步骤 6-7: 审核

```bash
cd ../3_审核

# 6. 生成审核网页（传入视频文件，自动创建符号链接）
node "$SKILL_DIR/scripts/generate_review.js" ../1_转录/subtitles_words.json ../2_分析/auto_selected.json "$VIDEO_PATH"
# 输出: review.html, video.mp4(符号链接)

# 7. 启动审核服务器
node "$SKILL_DIR/scripts/review_server.js" 8899 "$VIDEO_PATH"
# 打开 http://localhost:8899
```

> ⚠️ **必须用 review_server.js**，不能用 `python3 -m http.server` 替代。
> 原因：视频播放依赖 HTTP Range 请求（206），python 简易服务器不支持，会导致视频无法播放/无声音。
> 启动时不要在命令末尾加 `&`（shell 后台），用 `run_in_background` 参数即可。

用户在网页中：
- 播放视频画面确认
- 勾选/取消删除项
- 点击「执行剪辑」

---

## 数据格式

### subtitles_words.json

```json
[
  {"text": "大", "start": 0.12, "end": 0.2, "isGap": false},
  {"text": "", "start": 6.78, "end": 7.48, "isGap": true}
]
```

### auto_selected.json

```json
[72, 85, 120]  // Claude 分析生成的预选索引
```

---

## 剪辑编码（硬性规则）

⚠️ **匹配原片参数重编码，帧级精确切割。**

`cut_video.sh` 的工作方式：
1. 自动检测原片编码参数（codec/profile/pix_fmt/bitrate）
2. 用 `filter_complex` trim+concat 帧级精确切割
3. 以相同参数重编码：`-profile:v high -b:v {原片码率} -pix_fmt yuv420p`

**关键**：重编码画质取决于是否匹配原片参数，不是 CRF 值。
- ✅ `-b:v {原片码率} -profile:v high -pix_fmt yuv420p` → 肉眼无区别
- ❌ 只指定 `-crf N` 不指定 profile/pix_fmt → 可能有偏差

---

## 配置

### 火山引擎 API Key

```bash
cd /Users/chengfeng/Desktop/AIos/剪辑Agent/.claude/skills
cp .env.example .env
# 编辑 .env 填入 VOLCENGINE_API_KEY=xxx
```
