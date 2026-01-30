#!/usr/bin/env node
/**
 * 从火山引擎结果生成字级别字幕
 *
 * 用法: node generate_subtitles.js <volcengine_result.json> [delete_segments.json]
 * 输出: subtitles_words.json
 */

const fs = require('fs');

const resultFile = process.argv[2] || 'volcengine_result.json';
const deleteFile = process.argv[3];

if (!fs.existsSync(resultFile)) {
  console.error('❌ 找不到文件:', resultFile);
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));

// 提取所有字
const allWords = [];
for (const utterance of result.utterances) {
  if (utterance.words) {
    for (const word of utterance.words) {
      allWords.push({
        text: word.text,
        start: word.start_time / 1000,
        end: word.end_time / 1000
      });
    }
  }
}

console.log('原始字数:', allWords.length);

// 如果有删除片段，映射时间
let outputWords = allWords;

if (deleteFile && fs.existsSync(deleteFile)) {
  const deleteSegments = JSON.parse(fs.readFileSync(deleteFile, 'utf8'));
  console.log('删除片段数:', deleteSegments.length);

  function getDeletedTimeBefore(time) {
    let deleted = 0;
    for (const seg of deleteSegments) {
      if (seg.end <= time) {
        deleted += seg.end - seg.start;
      } else if (seg.start < time) {
        deleted += time - seg.start;
      }
    }
    return deleted;
  }

  function isDeleted(start, end) {
    for (const seg of deleteSegments) {
      if (start < seg.end && end > seg.start) return true;
    }
    return false;
  }

  outputWords = [];
  for (const word of allWords) {
    if (!isDeleted(word.start, word.end)) {
      const deletedBefore = getDeletedTimeBefore(word.start);
      outputWords.push({
        text: word.text,
        start: Math.round((word.start - deletedBefore) * 100) / 100,
        end: Math.round((word.end - deletedBefore) * 100) / 100
      });
    }
  }
  console.log('映射后字数:', outputWords.length);
}

// 添加空白标记（>0.5秒的静音按1秒拆分，便于精细控制）
const wordsWithGaps = [];
let lastEnd = 0;

for (const word of outputWords) {
  const gapDuration = word.start - lastEnd;

  if (gapDuration > 0.1) {
    // 如果静音 >0.5秒，按1秒拆分
    if (gapDuration > 0.5) {
      let gapStart = lastEnd;
      while (gapStart < word.start) {
        const gapEnd = Math.min(gapStart + 1, word.start);
        wordsWithGaps.push({
          text: '',
          start: Math.round(gapStart * 100) / 100,
          end: Math.round(gapEnd * 100) / 100,
          isGap: true
        });
        gapStart = gapEnd;
      }
    } else {
      // <1秒的静音保持原样
      wordsWithGaps.push({
        text: '',
        start: Math.round(lastEnd * 100) / 100,
        end: Math.round(word.start * 100) / 100,
        isGap: true
      });
    }
  }

  wordsWithGaps.push({
    text: word.text,
    start: word.start,
    end: word.end,
    isGap: false
  });
  lastEnd = word.end;
}

const gaps = wordsWithGaps.filter(w => w.isGap);
console.log('总元素数:', wordsWithGaps.length);
console.log('空白段数:', gaps.length);

fs.writeFileSync('subtitles_words.json', JSON.stringify(wordsWithGaps, null, 2));
console.log('✅ 已保存 subtitles_words.json');
