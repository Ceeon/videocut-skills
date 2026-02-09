#!/usr/bin/env node
/**
 * 字幕审核服务器
 * 直接编辑 subtitles_with_time.json，时间戳不变
 *
 * 用法: node subtitle_server.js [port] [video_path]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = process.argv[2] || 8898;
const VIDEO_PATH = process.argv[3] || '';
const SUBTITLES_FILE = './subtitles_with_time.json';

// 读取字幕数据
let subtitles = [];
if (fs.existsSync(SUBTITLES_FILE)) {
  subtitles = JSON.parse(fs.readFileSync(SUBTITLES_FILE, 'utf8'));
  console.log(`📝 加载 ${subtitles.length} 条字幕`);
} else {
  console.error('❌ 找不到 subtitles_with_time.json');
  process.exit(1);
}

// 读取词典
const DICT_FILE = path.join(__dirname, '..', '词典.txt');
let dictionary = [];
if (fs.existsSync(DICT_FILE)) {
  dictionary = fs.readFileSync(DICT_FILE, 'utf8').split('\n').filter(l => l.trim());
  console.log(`📖 加载词典 ${dictionary.length} 条`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: 获取字幕
  if (req.url === '/api/subtitles') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(subtitles));
    return;
  }

  // API: 保存字幕
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        subtitles = JSON.parse(body);
        fs.writeFileSync(SUBTITLES_FILE, JSON.stringify(subtitles, null, 2));
        console.log('💾 已保存字幕');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: 生成 SRT
  if (req.url === '/api/srt') {
    const srt = generateSRT(subtitles);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(srt);
    return;
  }

  // API: 保存 SRT 文件
  if (req.method === 'POST' && req.url === '/api/save-srt') {
    const srt = generateSRT(subtitles);
    const srtPath = './3_输出/' + path.basename(VIDEO_PATH, '.mp4') + '.srt';
    fs.mkdirSync('./3_输出', { recursive: true });
    fs.writeFileSync(srtPath, srt);
    console.log('💾 已保存 SRT:', srtPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: srtPath }));
    return;
  }

  // API: 获取视频信息（时长+分辨率+帧率，用于预估烧录时间）
  if (req.url === '/api/video-info') {
    try {
      const dur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${VIDEO_PATH}"`).toString().trim());
      const streamInfo = execSync(`ffprobe -v error -show_entries stream=width,height,r_frame_rate -select_streams v:0 -of csv=p=0 "file:${VIDEO_PATH}"`).toString().trim();
      const parts = streamInfo.split(',');
      const width = parseInt(parts[0]) || 1920;
      const height = parseInt(parts[1]) || 1080;
      const fpsStr = parts[2] || '30/1';
      const fpsParts = fpsStr.split('/');
      const fps = fpsParts.length === 2 ? parseInt(fpsParts[0]) / parseInt(fpsParts[1]) : parseFloat(fpsStr);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ duration: dur, width, height, fps: Math.round(fps) }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ duration: 0, width: 1920, height: 1080, fps: 30 }));
    }
    return;
  }

  // API: 烧录字幕（SSE 实时进度）
  if (req.method === 'POST' && req.url === '/api/burn') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { outline } = JSON.parse(body);
        const outlineVal = outline || 2;
        const baseName = path.basename(VIDEO_PATH, '.mp4');

        fs.mkdirSync('./3_输出', { recursive: true });

        // 保存 SRT
        const srt = generateSRT(subtitles);
        const srtPath = './3_输出/' + baseName + '.srt';
        fs.writeFileSync(srtPath, srt);
        console.log('💾 已保存 SRT:', srtPath);

        // 保存人工校对格式 (方便存档)
        const readable = generateReadableSubtitles(subtitles);
        const readablePath = './3_输出/' + baseName + '_字幕稿.md';
        fs.writeFileSync(readablePath, readable);
        console.log('📝 已保存字幕稿:', readablePath);

        // 获取总帧数（用时长 × 帧率估算，比 -count_frames 快得多）
        let totalFrames = 0;
        try {
          const dur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${VIDEO_PATH}"`).toString().trim());
          const fpsStr = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "file:${VIDEO_PATH}"`).toString().trim();
          const fpsParts = fpsStr.split('/');
          const fps = fpsParts.length === 2 ? parseInt(fpsParts[0]) / parseInt(fpsParts[1]) : 30;
          totalFrames = Math.round(dur * fps);
        } catch(e) { totalFrames = 0; }

        // SSE 响应头
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const outputPath = './3_输出/' + baseName + '_字幕.mp4';
        const args = ['-i', VIDEO_PATH, '-vf', `subtitles='${srtPath}':force_style='FontSize=22,FontName=PingFang SC,Bold=1,PrimaryColour=&H0000deff,OutlineColour=&H00000000,Outline=${outlineVal},Alignment=2,MarginV=30'`, '-c:a', 'copy', '-y', outputPath];

        console.log('🎬 烧录字幕...');
        const startTime = Date.now();
        const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

        // 解析 ffmpeg stderr 进度
        let lastProgress = '';
        proc.stderr.on('data', (data) => {
          const line = data.toString();
          const frameMatch = line.match(/frame=\s*(\d+)/);
          const speedMatch = line.match(/speed=\s*([\d.]+)x/);
          const fpsMatch = line.match(/fps=\s*([\d.]+)/);
          if (frameMatch) {
            const frame = parseInt(frameMatch[1]);
            const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;
            const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
            const percent = totalFrames > 0 ? Math.min(99, Math.round(frame / totalFrames * 100)) : 0;
            const elapsed = (Date.now() - startTime) / 1000;
            let remaining = 0;
            if (percent > 0) remaining = Math.round(elapsed / percent * (100 - percent));
            const progress = JSON.stringify({ frame, totalFrames, percent, speed, fps, elapsed: Math.round(elapsed), remaining });
            if (progress !== lastProgress) {
              res.write(`data: ${progress}\n\n`);
              lastProgress = progress;
            }
          }
        });

        proc.on('close', (code) => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          if (code === 0) {
            console.log(`✅ 完成: ${outputPath} (耗时 ${elapsed}s)`);
            res.write(`data: ${JSON.stringify({ done: true, path: outputPath, srtPath, readablePath, elapsed })}\n\n`);
          } else {
            console.error(`❌ 烧录失败 (exit code ${code})`);
            res.write(`data: ${JSON.stringify({ error: `ffmpeg exit code ${code}` })}\n\n`);
          }
          res.end();
        });

        proc.on('error', (err) => {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          res.end();
        });

      } catch (err) {
        console.error('❌ 烧录失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 视频文件
  if (req.url === '/video.mp4' && VIDEO_PATH) {
    const stat = fs.statSync(VIDEO_PATH);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(VIDEO_PATH, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(VIDEO_PATH).pipe(res);
    }
    return;
  }

  // 主页面
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateHTML());
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function generateSRT(subs) {
  return subs.map((s, i) =>
    `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}\n`
  ).join('\n');
}

// 生成人工校对格式的字幕文件
function generateReadableSubtitles(subs) {
  return subs.map((s, i) => {
    const start = formatReadableTime(s.start);
    const end = formatReadableTime(s.end);
    return `${i + 1}. ${start} → ${end}\n${s.text}`;
  }).join('\n');
}

function formatReadableTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2);
  return m.toString().padStart(2, '0') + ':' + s.padStart(5, '0');
}

function generateHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>字幕审核</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #1a1a1a; color: #e0e0e0; }
    .container { display: flex; height: 100vh; }

    .video-panel { flex: 1; padding: 20px; display: flex; flex-direction: column; }
    video { width: 100%; max-height: 60vh; background: #000; border-radius: 8px; }

    .controls { margin-top: 15px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-primary { background: #4CAF50; color: white; }
    .btn-primary:hover { background: #45a049; }
    .btn-secondary { background: #2196F3; color: white; }
    .btn-secondary:hover { background: #1976D2; }
    .btn-danger { background: #f44336; color: white; }

    select { padding: 8px; background: #333; color: white; border: none; border-radius: 4px; }

    .subtitle-panel { width: 450px; border-left: 1px solid #333; display: flex; flex-direction: column; }
    .subtitle-header { padding: 15px; background: #252525; border-bottom: 1px solid #333; }
    .subtitle-header h2 { font-size: 16px; margin-bottom: 10px; }
    .search-box { width: 100%; padding: 8px; background: #333; border: none; border-radius: 4px; color: white; }

    .subtitle-list { flex: 1; overflow-y: auto; }
    .subtitle-item { padding: 12px 15px; border-bottom: 1px solid #252525; cursor: pointer; }
    .subtitle-item:hover { background: #252525; }
    .subtitle-item.active { background: #0f3460; border-left: 3px solid #4CAF50; }
    .subtitle-item.editing { background: #1a3a5c; }

    .sub-time { font-size: 12px; color: #888; margin-bottom: 5px; font-family: monospace; }
    .sub-text { font-size: 14px; line-height: 1.5; }
    .sub-text input { width: 100%; padding: 8px; background: #333; border: 1px solid #4CAF50; border-radius: 4px; color: white; font-size: 14px; }

    .dict-panel { padding: 10px 15px; background: #252525; border-top: 1px solid #333; font-size: 12px; color: #888; }
    .dict-word { display: inline-block; background: #333; padding: 2px 8px; margin: 2px; border-radius: 3px; cursor: pointer; }
    .dict-word:hover { background: #4CAF50; color: white; }

    .status { padding: 10px 15px; background: #1a3a1a; color: #4CAF50; font-size: 12px; }
    .status.error { background: #3a1a1a; color: #f44336; }
    .progress-wrap { display:none; margin-top:6px; }
    .progress-wrap.active { display:block; }
    .progress-bar { height:6px; background:#333; border-radius:3px; overflow:hidden; }
    .progress-bar-fill { height:100%; background:#4CAF50; border-radius:3px; transition:width 0.3s; width:0%; }
    .progress-text { font-size:12px; color:#aaa; margin-top:4px; display:flex; justify-content:space-between; }
  </style>
</head>
<body>
  <div class="container">
    <div class="video-panel">
      <video id="video" controls>
        <source src="/video.mp4" type="video/mp4">
      </video>
      <div class="controls">
        <button class="btn-primary" onclick="video.paused ? video.play() : video.pause()">▶️ 播放/暂停</button>
        <select onchange="video.playbackRate = this.value">
          <option value="0.5">0.5x</option>
          <option value="1" selected>1x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
          <option value="3">3x</option>
        </select>
        <button class="btn-secondary" onclick="saveSubtitles()">💾 保存字幕</button>
        <button class="btn-secondary" onclick="saveSRT()">📄 导出 SRT</button>
        <button class="btn-primary" onclick="burnSubtitles()">🎬 烧录字幕</button>
        <label style="margin-left:10px; font-size:14px;">描边: <input type="number" id="outline" value="2" min="1" max="5" style="width:50px;padding:5px;background:#333;border:none;color:white;border-radius:4px;"></label>
      </div>
      <div class="status" id="status">就绪</div>
      <div class="progress-wrap" id="progressWrap">
        <div class="progress-bar"><div class="progress-bar-fill" id="progressFill"></div></div>
        <div class="progress-text"><span id="progressLeft"></span><span id="progressRight"></span></div>
      </div>
    </div>

    <div class="subtitle-panel">
      <div class="subtitle-header">
        <h2>字幕列表 (<span id="count">0</span>)</h2>
        <input type="text" class="search-box" placeholder="搜索..." oninput="filterSubtitles(this.value)">
      </div>
      <div class="subtitle-list" id="subtitleList"></div>
      <div class="dict-panel">
        <strong>词典：</strong>
        <span id="dictWords">${dictionary.map(w => `<span class="dict-word" onclick="insertWord('${w}')">${w}</span>`).join('')}</span>
      </div>
    </div>
  </div>

  <script>
    const video = document.getElementById('video');
    let subtitles = [];
    let editingIdx = -1;

    async function loadSubtitles() {
      const res = await fetch('/api/subtitles');
      subtitles = await res.json();
      document.getElementById('count').textContent = subtitles.length;
      renderSubtitles();
    }

    function renderSubtitles(filter = '') {
      const list = document.getElementById('subtitleList');
      list.innerHTML = subtitles.map((s, i) => {
        if (filter && !s.text.includes(filter)) return '';
        const isEditing = i === editingIdx;
        return \`
          <div class="subtitle-item \${isEditing ? 'editing' : ''}" data-idx="\${i}" onclick="jumpTo(\${i})">
            <div class="sub-time">\${i + 1}. \${formatTime(s.start)} → \${formatTime(s.end)}</div>
            <div class="sub-text">
              \${isEditing
                ? \`<input type="text" value="\${s.text}" onblur="finishEdit(\${i}, this.value)" onkeydown="if(event.key==='Enter')this.blur()">\`
                : \`<span ondblclick="startEdit(\${i})">\${s.text}</span>\`
              }
            </div>
          </div>
        \`;
      }).join('');

      if (editingIdx >= 0) {
        const input = list.querySelector('input');
        if (input) { input.focus(); input.select(); }
      }
    }

    function formatTime(s) {
      const m = Math.floor(s / 60);
      const sec = (s % 60).toFixed(2);
      return m.toString().padStart(2, '0') + ':' + sec.padStart(5, '0');
    }

    function jumpTo(idx) {
      if (editingIdx >= 0) return;
      video.currentTime = subtitles[idx].start;
      highlightCurrent(idx);
    }

    function startEdit(idx) {
      editingIdx = idx;
      renderSubtitles();
    }

    function finishEdit(idx, value) {
      subtitles[idx].text = value;
      editingIdx = -1;
      renderSubtitles();
      setStatus('已修改，记得保存');
    }

    function filterSubtitles(filter) {
      renderSubtitles(filter);
    }

    function insertWord(word) {
      if (editingIdx >= 0) {
        const input = document.querySelector('.subtitle-item.editing input');
        if (input) {
          const start = input.selectionStart;
          const end = input.selectionEnd;
          input.value = input.value.slice(0, start) + word + input.value.slice(end);
          input.focus();
        }
      }
    }

    function highlightCurrent(idx) {
      document.querySelectorAll('.subtitle-item').forEach((el, i) => {
        el.classList.toggle('active', parseInt(el.dataset.idx) === idx);
      });
      const active = document.querySelector('.subtitle-item.active');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    video.addEventListener('timeupdate', () => {
      const t = video.currentTime;
      const idx = subtitles.findIndex(s => t >= s.start && t < s.end);
      if (idx >= 0) highlightCurrent(idx);
    });

    async function saveSubtitles() {
      setStatus('保存中...');
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subtitles)
      });
      const data = await res.json();
      setStatus(data.success ? '✅ 已保存' : '❌ 保存失败', !data.success);
    }

    async function saveSRT() {
      setStatus('导出 SRT...');
      const res = await fetch('/api/save-srt', { method: 'POST' });
      const data = await res.json();
      setStatus(data.success ? '✅ SRT 已保存: ' + data.path : '❌ 导出失败', !data.success);
    }

    function fmtTime(sec) {
      if (sec <= 0) return '0秒';
      const m = Math.floor(sec / 60), s = sec % 60;
      return m > 0 ? m + '分' + s + '秒' : s + '秒';
    }

    async function burnSubtitles() {
      if (!confirm('确认烧录字幕？\\n\\n点击确定开始')) return;

      const outline = document.getElementById('outline').value;
      const progressWrap = document.getElementById('progressWrap');
      const progressFill = document.getElementById('progressFill');
      const progressLeft = document.getElementById('progressLeft');
      const progressRight = document.getElementById('progressRight');

      progressWrap.classList.add('active');
      progressFill.style.width = '0%';
      setStatus('🎬 烧录中... 准备编码');

      try {
        const res = await fetch('/api/burn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outline })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // 解析 SSE data 行
          const lines = buf.split('\\n');
          buf = lines.pop(); // 保留不完整的行
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const d = JSON.parse(line.slice(6));
            if (d.done) {
              progressFill.style.width = '100%';
              progressLeft.textContent = '100%';
              progressRight.textContent = \`耗时 \${fmtTime(Math.round(parseFloat(d.elapsed)))}\`;
              setStatus(\`✅ 烧录完成 (耗时\${d.elapsed}s): \${d.path}\`);
              setTimeout(() => progressWrap.classList.remove('active'), 5000);
              return;
            }
            if (d.error) {
              setStatus('❌ 烧录失败: ' + d.error, true);
              progressWrap.classList.remove('active');
              return;
            }
            // 更新进度
            progressFill.style.width = d.percent + '%';
            progressLeft.textContent = d.percent + '%';
            const speedText = d.speed > 0 ? \` | \${d.speed}x\` : '';
            progressRight.textContent = \`剩余 \${fmtTime(d.remaining)}\${speedText}\`;
            setStatus(\`🎬 烧录中... \${d.percent}% | 剩余 \${fmtTime(d.remaining)}\`);
          }
        }
      } catch(err) {
        setStatus('❌ 请求失败: ' + err.message, true);
        progressWrap.classList.remove('active');
      }
    }

    function setStatus(msg, isError = false) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status' + (isError ? ' error' : '');
    }

    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      }
    });

    loadSubtitles();
  </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`
🎬 字幕审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 视频: ${VIDEO_PATH}

操作说明:
- 双击字幕文字进行编辑
- 点击字幕跳转到对应时间
- 空格键播放/暂停
- 编辑完成后点击「保存字幕」
- 最后点击「烧录字幕」生成视频
  `);
});
