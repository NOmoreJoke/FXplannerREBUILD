#!/usr/bin/env node

/**
 * 生成带自动播放视频的测试报告
 * 使用方法: node generate-video-report.js
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../test-results/playwright-output');
const REPORT_FILE = path.join(__dirname, '../test-results/video-report.html');

// 递归查找所有视频文件
function findVideos(dir) {
  const videos = [];

  function walk(currentDir) {
    const files = fs.readdirSync(currentDir);

    for (const file of files) {
      const fullPath = path.join(currentDir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (file === 'video.webm') {
        // 获取测试名称（从路径中提取）
        const testName = path.basename(path.dirname(fullPath));
        // 计算相对于 test-results 目录的路径
        const relativePath = path.relative(
          path.join(__dirname, '../test-results'),
          fullPath
        );

        videos.push({
          name: testName,
          path: relativePath,
        });
      }
    }
  }

  walk(dir);
  return videos;
}

// 生成 HTML
function generateHTML(videos) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>测试视频报告 - 自动播放</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a1a;
      color: #fff;
      padding: 20px;
    }

    h1 {
      text-align: center;
      margin-bottom: 30px;
      color: #4CAF50;
    }

    .info {
      text-align: center;
      margin-bottom: 20px;
      color: #888;
    }

    .video-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(800px, 1fr));
      gap: 30px;
      max-width: 1800px;
      margin: 0 auto;
    }

    .video-card {
      background: #2a2a2a;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }

    .video-title {
      padding: 15px;
      background: #333;
      font-size: 14px;
      font-weight: 500;
      border-bottom: 1px solid #444;
      overflow-wrap: break-word;
    }

    video {
      width: 100%;
      display: block;
      background: #000;
    }

    .controls {
      padding: 10px 15px;
      display: flex;
      gap: 10px;
      justify-content: center;
      background: #2a2a2a;
    }

    button {
      padding: 8px 16px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }

    button:hover {
      background: #45a049;
    }

    button.secondary {
      background: #666;
    }

    button.secondary:hover {
      background: #555;
    }
  </style>
</head>
<body>
  <h1>🎬 测试视频报告（自动播放）</h1>
  <div class="info">
    共 ${videos.length} 个测试视频 |
    <button onclick="playAll()">▶️ 全部播放</button>
    <button onclick="pauseAll()" class="secondary">⏸️ 全部暂停</button>
    <button onclick="setSpeed(2)" class="secondary">2倍速</button>
    <button onclick="setSpeed(1)" class="secondary">正常速度</button>
  </div>

  <div class="video-grid">
    ${videos.map((video, index) => `
      <div class="video-card">
        <div class="video-title">${index + 1}. ${video.name}</div>
        <video
          id="video-${index}"
          src="${video.path}"
          controls
          autoplay
          muted
          loop
          playsinline
        ></video>
      </div>
    `).join('')}
  </div>

  <script>
    const videos = document.querySelectorAll('video');

    function playAll() {
      videos.forEach(v => v.play());
    }

    function pauseAll() {
      videos.forEach(v => v.pause());
    }

    function setSpeed(speed) {
      videos.forEach(v => v.playbackRate = speed);
    }

    // 默认静音自动播放
    videos.forEach(v => {
      v.muted = true;
      v.play().catch(() => {});
    });

    console.log('✅ 已加载 ${videos.length} 个视频');
  </script>
</body>
</html>`;
}

// 主函数
function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error('❌ 测试结果目录不存在:', OUTPUT_DIR);
    process.exit(1);
  }

  console.log('📂 扫描视频文件...');
  const videos = findVideos(OUTPUT_DIR);

  if (videos.length === 0) {
    console.warn('⚠️  未找到视频文件');
    process.exit(0);
  }

  console.log(`✅ 找到 ${videos.length} 个视频`);

  const html = generateHTML(videos);
  fs.writeFileSync(REPORT_FILE, html);

  console.log(`\n📊 视频报告已生成:\n   ${REPORT_FILE}\n`);
  console.log('💡 用浏览器打开即可自动播放所有视频');
}

main();
