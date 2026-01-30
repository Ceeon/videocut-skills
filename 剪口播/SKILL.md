---
name: videocut:剪口播
description: 口播视频转录和口误识别。生成审查稿和删除任务清单。触发词：剪口播、处理视频、识别口误
---

<!--
input: 视频文件 (*.mp4)
output: subtitles_words.json、auto_selected.json、review.html
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
    │       └── review.html
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
    if (dur >= 0.5) output.push(i + '|[静' + dur + 's]|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
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
  if (w.isGap && (w.end - w.start) >= 0.5) selected.push(i);
});
require('fs').writeFileSync('auto_selected.json', JSON.stringify(selected, null, 2));
console.log('≥0.5s静音数量:', selected.length);
"
```

→ 输出 `auto_selected.json`（只含静音 idx）

#### 5.5 AI 分析口误（追加到 auto_selected.json）

**检测规则（按优先级）**：

| # | 类型 | 判断方法 | 删除范围 |
|---|------|----------|----------|
| 1 | 重复句 | 相邻句子开头≥5字相同 | 较短的**整句** |
| 2 | 隔一句重复 | 中间是残句时，比对前后句 | 前句+残句 |
| 3 | 残句 | 话说一半+静音 | **整个残句** |
| 4 | 句内重复 | A+中间+A 模式 | 前面部分 |
| 5 | 卡顿词 | 那个那个、就是就是 | 前面部分 |
| 6 | 重说纠正 | 部分重复/否定纠正 | 前面部分 |
| 7 | 语气词 | 嗯、啊、那个 | 标记但不自动删 |

**核心原则**：
- **先分句，再比对**：用 sentences.txt 比对相邻句子
- **整句删除**：残句、重复句都要删整句，不只是删异常的几个字

**分段分析（循环执行）**：

```
1. Read readable.txt offset=N limit=300
2. 结合 sentences.txt 分析这300行
3. 追加口误 idx 到 auto_selected.json
4. 记录到 口误分析.md
5. N += 300，回到步骤1
```

🚨 **关键警告：行号 ≠ idx**

```
readable.txt 格式: idx|内容|时间
                   ↑ 用这个值

行号1500 → "1568|[静1.02s]|..."  ← idx是1568，不是1500！
```

**口误分析.md 格式：**

```markdown
## 第N段 (行号范围)

| idx | 时间 | 类型 | 内容 | 处理 |
|-----|------|------|------|------|
| 65-75 | 15.80-17.66 | 重复句 | "这是我剪出来的一个案例" | 删 |
```

### 步骤 6-7: 审核

```bash
cd ../3_审核

# 6. 生成审核网页
node "$SKILL_DIR/scripts/generate_review.js" ../1_转录/subtitles_words.json ../2_分析/auto_selected.json ../1_转录/audio.mp3
# 输出: review.html

# 7. 启动审核服务器
node "$SKILL_DIR/scripts/review_server.js" 8899 "$VIDEO_PATH"
# 打开 http://localhost:8899
```

用户在网页中：
- 播放视频片段确认
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

## 配置

### 火山引擎 API Key

```bash
cd /Users/chengfeng/Desktop/AIos/剪辑Agent/.claude/skills
cp .env.example .env
# 编辑 .env 填入 VOLCENGINE_API_KEY=xxx
```
