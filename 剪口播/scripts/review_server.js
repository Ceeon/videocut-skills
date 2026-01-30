#!/usr/bin/env node
/**
 * 审核服务器
 *
 * 功能：
 * 1. 提供静态文件服务（review.html, audio.mp3）
 * 2. POST /api/cut - 接收删除列表，执行剪辑
 *
 * 用法: node review_server.js [port] [video_file]
 * 默认: port=8899, video_file=自动检测目录下的 .mp4
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.argv[2] || 8899;
let VIDEO_FILE = process.argv[3] || findVideoFile();

function findVideoFile() {
  const files = fs.readdirSync('.').filter(f => f.endsWith('.mp4'));
  return files[0] || 'source.mp4';
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: 执行剪辑
  if (req.method === 'POST' && req.url === '/api/cut') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const deleteList = JSON.parse(body);

        // 保存删除列表到当前目录
        fs.writeFileSync('delete_segments.json', JSON.stringify(deleteList, null, 2));
        console.log(`📝 保存 ${deleteList.length} 个删除片段`);

        // 生成输出文件名
        const baseName = path.basename(VIDEO_FILE, '.mp4');
        const outputFile = `${baseName}_cut.mp4`;

        // 执行剪辑
        const scriptPath = path.join(__dirname, 'cut_video.sh');

        if (!fs.existsSync(scriptPath)) {
          // 如果没有 cut_video.sh，用内置的 ffmpeg 命令
          console.log('🎬 执行剪辑...');
          executeFFmpegCut(VIDEO_FILE, deleteList, outputFile);
        } else {
          console.log('🎬 调用 cut_video.sh...');
          execSync(`bash "${scriptPath}" "${VIDEO_FILE}" delete_segments.json "${outputFile}"`, {
            stdio: 'inherit'
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputFile,
          message: `剪辑完成: ${outputFile}`
        }));

      } catch (err) {
        console.error('❌ 剪辑失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 静态文件服务（从当前目录读取）
  let filePath = req.url === '/' ? '/review.html' : req.url;
  filePath = '.' + filePath;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(filePath);

  // 支持 Range 请求（音频/视频拖动）
  if (req.headers.range && (ext === '.mp3' || ext === '.mp4')) {
    const range = req.headers.range.replace('bytes=', '').split('-');
    const start = parseInt(range[0], 10);
    const end = range[1] ? parseInt(range[1], 10) : stat.size - 1;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  // 普通请求
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(filePath).pipe(res);
});

// 内置 FFmpeg 剪辑逻辑（分段切割 + concat 方案，和预览完全一致的精度）
function executeFFmpegCut(input, deleteList, output) {
  // 检测音频偏移量（audio.mp3 的 start_time）
  let audioOffset = 0;
  try {
    const offsetCmd = `ffprobe -v error -show_entries format=start_time -of csv=p=0 audio.mp3`;
    audioOffset = parseFloat(execSync(offsetCmd).toString().trim()) || 0;
    if (audioOffset > 0) {
      console.log(`🔧 检测到音频偏移: ${audioOffset.toFixed(3)}s，自动补偿`);
    }
  } catch (e) {
    // 忽略，使用默认 0
  }

  // 补偿偏移：转录时间戳是基于 audio.mp3 的，需要减去偏移才能对应原视频
  const sortedDelete = [...deleteList]
    .map(seg => ({
      start: Math.max(0, seg.start - audioOffset),
      end: seg.end - audioOffset
    }))
    .sort((a, b) => a.start - b.start);

  // 计算保留片段
  const keepSegments = [];
  let lastEnd = 0;

  // 获取视频总时长
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${input}"`;
  const duration = parseFloat(execSync(probeCmd).toString().trim());

  for (const seg of sortedDelete) {
    // 直接使用原始时间戳，和预览一致
    if (seg.start > lastEnd) {
      keepSegments.push({ start: lastEnd, end: seg.start });
    }
    lastEnd = Math.max(lastEnd, seg.end);
  }
  if (lastEnd < duration) {
    keepSegments.push({ start: lastEnd, end: duration });
  }

  console.log(`保留 ${keepSegments.length} 个片段`);

  // 创建临时目录
  const tmpDir = `tmp_cut_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 分段切割（每个片段独立编码，精度最高）
    const partFiles = [];
    keepSegments.forEach((seg, i) => {
      const partFile = path.join(tmpDir, `part${i.toString().padStart(4, '0')}.mp4`);
      const segDuration = seg.end - seg.start;

      // 使用输入前 -ss（精确 seek）+ 重编码
      const cmd = `ffmpeg -y -ss ${seg.start.toFixed(3)} -i "file:${input}" -t ${segDuration.toFixed(3)} -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 128k -avoid_negative_ts make_zero "${partFile}"`;

      console.log(`切割片段 ${i + 1}/${keepSegments.length}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s`);
      execSync(cmd, { stdio: 'pipe' });
      partFiles.push(partFile);
    });

    // 生成 concat 列表
    const listFile = path.join(tmpDir, 'list.txt');
    const listContent = partFiles.map(f => `file '${path.resolve(f)}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    // 用 concat demuxer 合并（无损合并）
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`;
    console.log('合并片段...');
    execSync(concatCmd, { stdio: 'pipe' });

    console.log(`✅ 输出: ${output}`);

  } finally {
    // 清理临时文件
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

server.listen(PORT, () => {
  console.log(`
🎬 审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 视频: ${VIDEO_FILE}

操作说明:
1. 在网页中审核选择要删除的片段
2. 点击「🎬 执行剪辑」按钮
3. 等待剪辑完成
  `);
});
