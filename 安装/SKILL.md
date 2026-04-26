---
name: videocut:安装
description: 环境准备。安装依赖、配置 API Key、验证环境。触发词：安装、环境准备、初始化
---

<!--
input: 无
output: 环境就绪
pos: 前置 skill，首次使用前运行

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. /CLAUDE.md 路由表
-->

# 安装

> 首次使用前的环境准备

## 快速使用

```
用户: 安装环境
用户: 初始化
```

## 依赖清单

| 依赖 | 用途 | 安装命令 |
|------|------|----------|
| Node.js | 运行脚本 | `brew install node` |
| FFmpeg | 视频剪辑 | `brew install ffmpeg` |
| curl | API 调用 | 系统自带 |

## API 配置

### 火山引擎语音识别

控制台：https://console.volcengine.com/speech/new/experience/asr?projectName=default

1. 注册火山引擎账号
2. 开通语音识别服务
3. 获取 API Key；如使用音视频字幕生成 v1，还需获取 AppID 和 Access Token

配置到项目目录 `.claude/skills/.env`：

```bash
# 文件路径：剪辑Agent/.claude/skills/.env
VOLCENGINE_API_KEY=your_api_key_here

# 可选：音视频字幕生成 v1
VOLCENGINE_APPID=your_appid_here
VOLCENGINE_ACCESS_TOKEN=your_access_token_here
```

## 安装流程

```
1. 安装 Node.js + FFmpeg
       ↓
2. 配置火山引擎 API Key
       ↓
3. 验证环境
```

## 执行步骤

### 1. 安装依赖

```bash
# macOS
brew install node ffmpeg

# 验证
node -v
ffmpeg -version
```

### 2. 配置 API Key

```bash
# 在项目 .claude/skills/ 目录下创建 .env 文件
echo "VOLCENGINE_API_KEY=your_key" >> .claude/skills/.env

# 如果使用音视频字幕生成 v1：
echo "VOLCENGINE_APPID=your_appid" >> .claude/skills/.env
echo "VOLCENGINE_ACCESS_TOKEN=your_access_token" >> .claude/skills/.env
```

### 3. 验证环境

```bash
# 检查 Node.js
node -v

# 检查 FFmpeg
ffmpeg -version

# 检查 API Key（在项目目录下执行）
cat .claude/skills/.env | grep VOLCENGINE
```

## 常见问题

### Q1: API Key 在哪获取？

火山引擎控制台 → 语音技术 → 语音识别 → API Key

### Q2: ffmpeg 命令找不到

```bash
which ffmpeg  # 应该输出路径
# 如果没有，重新安装：brew install ffmpeg
```

### Q3: 文件名含冒号报错

FFmpeg 命令需加 `file:` 前缀：

```bash
ffmpeg -i "file:2026:01:26 task.mp4" ...
```
