#!/usr/bin/env node
/**
 * 生成审核网页（wavesurfer.js 版本）
 *
 * 用法: node generate_review.js <subtitles_words.json> [auto_selected.json] [audio_file]
 * 输出: review.html, audio.mp3（复制到当前目录）
 */

const fs = require('fs');
const path = require('path');

const subtitlesFile = process.argv[2] || 'subtitles_words.json';
const autoSelectedFile = process.argv[3] || 'auto_selected.json';
const audioFile = process.argv[4] || 'audio.mp3';

// 复制音频文件到当前目录（避免相对路径问题）
const audioBaseName = 'audio.mp3';
if (audioFile !== audioBaseName && fs.existsSync(audioFile)) {
  fs.copyFileSync(audioFile, audioBaseName);
  console.log('📁 已复制音频到当前目录:', audioBaseName);
}

if (!fs.existsSync(subtitlesFile)) {
  console.error('❌ 找不到字幕文件:', subtitlesFile);
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8'));
let autoSelected = [];

if (fs.existsSync(autoSelectedFile)) {
  autoSelected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
  console.log('AI 预选:', autoSelected.length, '个元素');
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审核稿</title>
  <script src="https://unpkg.com/wavesurfer.js@7"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: #1a1a1a;
      color: #e0e0e0;
    }
    h1 { text-align: center; margin-bottom: 20px; }

    .controls {
      position: sticky;
      top: 0;
      background: #1a1a1a;
      padding: 15px 0;
      border-bottom: 1px solid #333;
      z-index: 100;
    }

    .buttons {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 15px;
    }

    button {
      padding: 8px 16px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover { background: #45a049; }
    button.danger { background: #f44336; }
    button.danger:hover { background: #da190b; }

    select {
      padding: 8px 12px;
      background: #333;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
    }
    select:hover { background: #444; }

    #time {
      font-family: monospace;
      font-size: 16px;
      color: #888;
    }

    #waveform {
      background: #252525;
      border-radius: 4px;
      margin: 10px 0;
    }

    .content {
      line-height: 2.5;
      padding: 20px 0;
    }

    .word {
      display: inline-block;
      padding: 4px 2px;
      margin: 2px;
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .word:hover { background: #333; }
    .word.current { background: #2196F3; color: white; }
    .word.selected { background: #f44336; color: white; text-decoration: line-through; }
    .word.ai-selected { background: #ff9800; color: white; }
    .word.ai-selected.selected { background: #f44336; }

    .gap {
      display: inline-block;
      background: #333;
      color: #888;
      padding: 4px 8px;
      margin: 2px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
    }
    .gap:hover { background: #444; }
    .gap.selected { background: #f44336; color: white; }
    .gap.ai-selected { background: #ff9800; color: white; }
    .gap.ai-selected.selected { background: #f44336; }

    .stats {
      margin-top: 10px;
      padding: 10px;
      background: #252525;
      border-radius: 4px;
      font-size: 14px;
    }

    .help {
      font-size: 12px;
      color: #666;
      margin-top: 5px;
    }
  </style>
</head>
<body>
  <h1>审核稿</h1>

  <div class="controls">
    <div class="buttons">
      <button onclick="wavesurfer.playPause()">▶️ 播放/暂停</button>
      <select id="speed" onchange="wavesurfer.setPlaybackRate(parseFloat(this.value))">
        <option value="0.5">0.5x</option>
        <option value="0.75">0.75x</option>
        <option value="1" selected>1x</option>
        <option value="1.25">1.25x</option>
        <option value="1.5">1.5x</option>
        <option value="2">2x</option>
      </select>
      <button onclick="copyDeleteList()">📋 复制删除列表</button>
      <button onclick="executeCut()" style="background:#9C27B0">🎬 执行剪辑</button>
      <button class="danger" onclick="clearAll()">🗑️ 清空选择</button>
      <span id="time">00:00 / 00:00</span>
    </div>
    <div id="waveform"></div>
    <div class="help">单击跳转 | 双击选中/取消 | Shift+拖动多选/取消 | 空格播放 | ←→跳转</div>
  </div>

  <div class="content" id="content"></div>
  <div class="stats" id="stats"></div>

  <script>
    const words = ${JSON.stringify(words)};
    const autoSelected = new Set(${JSON.stringify(autoSelected)});
    const selected = new Set(autoSelected);

    // 初始化 wavesurfer
    const wavesurfer = WaveSurfer.create({
      container: '#waveform',
      waveColor: '#4a9eff',
      progressColor: '#1976D2',
      cursorColor: '#fff',
      height: 80,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url: '${audioBaseName}'
    });

    const timeDisplay = document.getElementById('time');
    const content = document.getElementById('content');
    const statsDiv = document.getElementById('stats');
    let elements = [];
    let isSelecting = false;
    let selectStart = -1;
    let selectMode = 'add'; // 'add' or 'remove'

    // 格式化时间
    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return \`\${m.toString().padStart(2, '0')}:\${s.toString().padStart(2, '0')}\`;
    }

    // 渲染内容
    function render() {
      content.innerHTML = '';
      elements = [];

      words.forEach((word, i) => {
        const div = document.createElement('div');
        div.className = word.isGap ? 'gap' : 'word';

        if (selected.has(i)) div.classList.add('selected');
        else if (autoSelected.has(i)) div.classList.add('ai-selected');

        if (word.isGap) {
          const duration = (word.end - word.start).toFixed(1);
          div.textContent = \`⏸ \${duration}s\`;
        } else {
          div.textContent = word.text;
        }

        div.dataset.index = i;

        // 单击跳转播放
        div.onclick = (e) => {
          if (!isSelecting) {
            wavesurfer.setTime(word.start);
          }
        };

        // 双击选中/取消
        div.ondblclick = () => toggle(i);

        // Shift+拖动选择/取消
        div.onmousedown = (e) => {
          if (e.shiftKey) {
            isSelecting = true;
            selectStart = i;
            selectMode = selected.has(i) ? 'remove' : 'add';
            e.preventDefault();
          }
        };

        content.appendChild(div);
        elements.push(div);
      });

      updateStats();
    }

    // Shift+拖动多选/取消
    content.addEventListener('mousemove', e => {
      if (!isSelecting) return;
      const target = e.target.closest('[data-index]');
      if (!target) return;

      const i = parseInt(target.dataset.index);
      const min = Math.min(selectStart, i);
      const max = Math.max(selectStart, i);

      for (let j = min; j <= max; j++) {
        if (selectMode === 'add') {
          selected.add(j);
          elements[j].classList.add('selected');
          elements[j].classList.remove('ai-selected');
        } else {
          selected.delete(j);
          elements[j].classList.remove('selected');
          if (autoSelected.has(j)) elements[j].classList.add('ai-selected');
        }
      }
      updateStats();
    });

    document.addEventListener('mouseup', () => {
      isSelecting = false;
    });

    function toggle(i) {
      if (selected.has(i)) {
        selected.delete(i);
        elements[i].classList.remove('selected');
        if (autoSelected.has(i)) elements[i].classList.add('ai-selected');
      } else {
        selected.add(i);
        elements[i].classList.add('selected');
        elements[i].classList.remove('ai-selected');
      }
      updateStats();
    }

    function updateStats() {
      const count = selected.size;
      let totalDuration = 0;
      selected.forEach(i => {
        totalDuration += words[i].end - words[i].start;
      });
      statsDiv.textContent = \`已选择 \${count} 个元素，总时长 \${totalDuration.toFixed(2)}s\`;
    }

    // 时间更新 & 高亮当前词 & 跳过选中片段
    wavesurfer.on('timeupdate', (t) => {
      // 播放时跳过选中片段（找到连续选中的末尾）
      if (wavesurfer.isPlaying()) {
        const sortedSelected = Array.from(selected).sort((a, b) => a - b);
        for (const i of sortedSelected) {
          const w = words[i];
          if (t >= w.start && t < w.end) {
            // 找到连续选中片段的末尾
            let endTime = w.end;
            let j = sortedSelected.indexOf(i) + 1;
            while (j < sortedSelected.length) {
              const nextIdx = sortedSelected[j];
              const nextW = words[nextIdx];
              // 如果下一个紧挨着（间隔<0.1s），继续跳
              if (nextW.start - endTime < 0.1) {
                endTime = nextW.end;
                j++;
              } else {
                break;
              }
            }
            wavesurfer.setTime(endTime);
            return;
          }
        }
      }

      timeDisplay.textContent = \`\${formatTime(t)} / \${formatTime(wavesurfer.getDuration())}\`;

      // 高亮当前词
      elements.forEach((el, i) => {
        const word = words[i];
        if (t >= word.start && t < word.end) {
          if (!el.classList.contains('current')) {
            el.classList.add('current');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        } else {
          el.classList.remove('current');
        }
      });
    });

    function copyDeleteList() {
      const segments = [];
      const sortedSelected = Array.from(selected).sort((a, b) => a - b);

      sortedSelected.forEach(i => {
        const word = words[i];
        segments.push({ start: word.start, end: word.end });
      });

      // 合并相邻片段
      const merged = [];
      for (const seg of segments) {
        if (merged.length === 0) {
          merged.push({ ...seg });
        } else {
          const last = merged[merged.length - 1];
          if (Math.abs(seg.start - last.end) < 0.05) {
            last.end = seg.end;
          } else {
            merged.push({ ...seg });
          }
        }
      }

      const json = JSON.stringify(merged, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        alert('已复制 ' + merged.length + ' 个删除片段到剪贴板');
      });
    }

    function clearAll() {
      selected.clear();
      elements.forEach((el, i) => {
        el.classList.remove('selected');
        if (autoSelected.has(i)) el.classList.add('ai-selected');
      });
      updateStats();
    }

    async function executeCut() {
      if (!confirm('确认执行剪辑？')) return;

      // 直接发送原始时间戳，不做合并（和预览一致）
      const segments = [];
      const sortedSelected = Array.from(selected).sort((a, b) => a - b);
      sortedSelected.forEach(i => {
        const word = words[i];
        segments.push({ start: word.start, end: word.end });
      });

      try {
        const res = await fetch('/api/cut', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(segments)  // 直接发原始数据
        });
        const data = await res.json();
        if (data.success) {
          alert('✅ ' + data.message);
        } else {
          alert('❌ 剪辑失败: ' + data.error);
        }
      } catch (err) {
        alert('❌ 请求失败: ' + err.message + '\\n\\n请确保使用 review_server.js 启动服务');
      }
    }

    // 键盘快捷键
    document.addEventListener('keydown', e => {
      if (e.code === 'Space') {
        e.preventDefault();
        wavesurfer.playPause();
      } else if (e.code === 'ArrowLeft') {
        wavesurfer.setTime(Math.max(0, wavesurfer.getCurrentTime() - (e.shiftKey ? 5 : 1)));
      } else if (e.code === 'ArrowRight') {
        wavesurfer.setTime(wavesurfer.getCurrentTime() + (e.shiftKey ? 5 : 1));
      }
    });

    render();
  </script>
</body>
</html>`;

fs.writeFileSync('review.html', html);
console.log('✅ 已生成 review.html');
console.log('📌 启动服务器: python3 -m http.server 8899');
console.log('📌 打开: http://localhost:8899/review.html');
