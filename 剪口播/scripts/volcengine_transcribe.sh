#!/bin/bash
#
# 火山引擎语音识别（异步模式）
#
# 用法: ./volcengine_transcribe.sh <audio_url>
# 输出: volcengine_result.json
#

AUDIO_URL="$1"

if [ -z "$AUDIO_URL" ]; then
  echo "❌ 用法: ./volcengine_transcribe.sh <audio_url>"
  exit 1
fi

# 获取 API 配置
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(dirname "$(dirname "$SCRIPT_DIR")")/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 找不到 $ENV_FILE"
  echo "请创建: cp .env.example .env 并填入 VOLCENGINE_API_KEY"
  exit 1
fi

API_KEY=$(grep '^VOLCENGINE_API_KEY=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)
APPID=$(grep '^VOLCENGINE_APPID=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)
ACCESS_TOKEN=$(grep '^VOLCENGINE_ACCESS_TOKEN=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)
TOKEN="${ACCESS_TOKEN:-$API_KEY}"

echo "🎤 提交火山引擎转录任务..."
echo "音频 URL: $AUDIO_URL"

# 读取热词词典
DICT_FILE="$(dirname "$SCRIPT_DIR")/字幕/词典.txt"
HOT_WORDS=""
if [ -f "$DICT_FILE" ]; then
  # 把词典转换成 JSON 数组格式
  HOT_WORDS=$(cat "$DICT_FILE" | grep -v '^$' | while read word; do echo "\"$word\""; done | tr '\n' ',' | sed 's/,$//')
  echo "📖 加载热词: $(cat "$DICT_FILE" | grep -v '^$' | wc -l | tr -d ' ') 个"
fi

# 构建请求体
if [ -n "$HOT_WORDS" ]; then
  REQUEST_BODY="{\"url\": \"$AUDIO_URL\", \"hot_words\": [$HOT_WORDS]}"
else
  REQUEST_BODY="{\"url\": \"$AUDIO_URL\"}"
fi

# 步骤1: 提交任务
if [ -n "$APPID" ] && [ -n "$TOKEN" ]; then
  # 官方音视频字幕生成 v1:
  # https://www.volcengine.com/docs/6561/80909
  SUBMIT_RESPONSE=$(curl -s -L -X POST "https://openspeech.bytedance.com/api/v1/vc/submit?appid=$APPID&language=zh-CN&use_itn=True&use_capitalize=True&max_lines=1&words_per_line=15" \
    -H "Accept: */*" \
    -H "Authorization: Bearer; $TOKEN" \
    -H "Connection: keep-alive" \
    -H "content-type: application/json" \
    -d "$REQUEST_BODY")
else
  # 新版控制台 API Key：录音文件极速版识别。
  # 返回结构不同，这里转换成后续脚本使用的 volcengine_result.json。
  REQ_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  FLASH_BODY="{\"user\":{\"uid\":\"videocut\"},\"audio\":{\"url\":\"$AUDIO_URL\"},\"request\":{\"model_name\":\"bigmodel\"}}"
  FLASH_HEADERS=$(mktemp)
  FLASH_RESPONSE=$(curl -s -D "$FLASH_HEADERS" -L -X POST "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash" \
    -H "X-Api-Key: $API_KEY" \
    -H "X-Api-Resource-Id: volc.bigasr.auc_turbo" \
    -H "X-Api-Request-Id: $REQ_ID" \
    -H "X-Api-Sequence: -1" \
    -H "content-type: application/json" \
    -d "$FLASH_BODY")
  FLASH_STATUS=$(awk 'BEGIN{IGNORECASE=1}/^X-Api-Status-Code:/{gsub("\r",""); print $2}' "$FLASH_HEADERS" | tail -1)
  rm -f "$FLASH_HEADERS"
  echo "$FLASH_RESPONSE" | FLASH_REQ_ID="$REQ_ID" FLASH_STATUS="$FLASH_STATUS" node -e "
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
const flash = JSON.parse(input);
const ok = process.env.FLASH_STATUS === '20000000' || (flash.result && Array.isArray(flash.result.utterances));
if (!ok) process.exit(1);
const converted = {
  id: process.env.FLASH_REQ_ID,
  code: 0,
  message: 'Success',
  utterances: flash.result?.utterances || [],
  text: flash.result?.text || '',
  audio_info: flash.audio_info || {}
};
fs.writeFileSync('volcengine_result.json', JSON.stringify(converted, null, 2));
console.log('✅ 转录完成，已保存 volcengine_result.json');
console.log('📝 识别到 ' + converted.utterances.length + ' 段语音');
"
  if [ $? -eq 0 ]; then
    exit 0
  fi
  SUBMIT_RESPONSE="$FLASH_RESPONSE"
fi

# 提取任务 ID
TASK_ID=$(echo "$SUBMIT_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$TASK_ID" ]; then
  echo "❌ 提交失败，响应:"
  echo "$SUBMIT_RESPONSE"
  exit 1
fi

echo "✅ 任务已提交，ID: $TASK_ID"
echo "⏳ 等待转录完成..."

# 步骤2: 轮询结果
MAX_ATTEMPTS=120  # 最多等待 10 分钟（每 5 秒查一次）
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 5
  ATTEMPT=$((ATTEMPT + 1))

  QUERY_RESPONSE=$(curl -s -L -X GET "https://openspeech.bytedance.com/api/v1/vc/query?appid=$APPID&id=$TASK_ID" \
    -H "Accept: */*" \
    -H "Authorization: Bearer; $TOKEN" \
    -H "Connection: keep-alive")

  # 检查状态
  STATUS=$(echo "$QUERY_RESPONSE" | grep -o '"code":[0-9]*' | head -1 | cut -d':' -f2)

  if [ "$STATUS" = "0" ]; then
    # 成功完成
    echo "$QUERY_RESPONSE" > volcengine_result.json
    echo "✅ 转录完成，已保存 volcengine_result.json"

    # 显示统计
    UTTERANCES=$(echo "$QUERY_RESPONSE" | grep -o '"text"' | wc -l)
    echo "📝 识别到 $UTTERANCES 段语音"
    exit 0
  elif [ "$STATUS" = "1000" ]; then
    # 处理中
    echo -n "."
  else
    # 其他错误
    echo ""
    echo "❌ 转录失败，响应:"
    echo "$QUERY_RESPONSE"
    exit 1
  fi
done

echo ""
echo "❌ 超时，任务未完成"
exit 1
