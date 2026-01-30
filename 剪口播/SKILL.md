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
└── YYYY-MM-DD_视频名/     # 日期+视频名
    ├── 剪口播/            # 本 skill 输出
    │   ├── audio.mp3
    │   ├── volcengine_result.json
    │   ├── subtitles_words.json
    │   ├── auto_selected.json
    │   └── review.html
    └── 字幕/              # 字幕 skill 输出
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
OUTPUT_DIR="output/${DATE}_${VIDEO_NAME}/剪口播"

# 创建目录（已存在则跳过）
mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"
```

### 步骤 1-3: 转录

```bash
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
```

### 步骤 5: AI 分析口误（Claude 手动）

**读取方法论后分析**：先读 `用户习惯/`

分析 `subtitles_words.json`，识别：
- 口误（重复、卡顿、替换）
- 静音（isGap=true 且 ≥1s）
- 语气词（嗯/哎/诶）

输出预选索引数组到 `auto_selected.json`：
```json
[72, 85, 120]  // 建议删除的 word 索引
```

### 步骤 6-7: 审核

```bash
# 6. 生成审核网页
node "$SKILL_DIR/scripts/generate_review.js" subtitles_words.json auto_selected.json audio.mp3

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

## 口误识别规则

详见 `用户习惯/`

| 类型 | 示例 | 删除策略 |
|------|------|----------|
| 重复型 | `拉满新拉满` | 只删差异（"新"） |
| 替换型 | `AI就是AI就会` | 删第一个完整版本 |
| 卡顿型 | `听会会` | 删第一个重复字 |

### 静音规则

- `isGap=true` 且时长 ≥1s → 建议删除
- 开头静音 >1s → 建议删除
- <1s 的短停顿 → 忽略（保留节奏感）

---

## 配置

### 火山引擎 API Key

```bash
cd /Users/chengfeng/Desktop/AIos/剪辑Agent/.claude/skills
cp .env.example .env
# 编辑 .env 填入 VOLCENGINE_API_KEY=xxx
```
