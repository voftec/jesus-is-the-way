// Full-compositor frame-by-frame capture of the ball→letter reveal sequence.
// Records the real composited page (DOM card + WebGL) via Playwright video,
// then ffmpeg extracts every frame. Usage:
//   node capture-reveal-frames.mjs [url] [outDir] [durationMs] [startDelayMs]
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:49412/';
const outDir = process.argv[3] || '/tmp/reveal-frames';
const duration = parseInt(process.argv[4] || '9000', 10);
const startDelay = parseInt(process.argv[5] || '900', 10);

fs.mkdirSync(outDir, { recursive: true });
const videoDir = `${outDir}/video`;
fs.mkdirSync(videoDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 430, height: 930 },
  recordVideo: { dir: videoDir, size: { width: 430, height: 930 } },
});
const page = await ctx.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => new Promise(r => {
  const iv = setInterval(() => {
    if (window.__perf?.some(([n]) => n === 'machine-ready')) { clearInterval(iv); r(1); }
  }, 80);
  setTimeout(() => { clearInterval(iv); r(0); }, 20000);
}));

if (url.includes('reveal=')) {
  // preview mode auto-enters + auto-triggers — just wait for its sequence
  await page.waitForTimeout(startDelay);
} else {
  await page.click('#enter-btn');
  await page.waitForTimeout(startDelay);
  await page.evaluate(() => window.__verse.test(8));
}
// Record until the card is fully open + tail margin (no duration guessing —
// under video load the whole timeline stretches)
await page.waitForFunction(
  "document.getElementById('verse-reveal')?.classList.contains('open')",
  { timeout: duration }
).catch(() => {});
await page.waitForTimeout(2500);

const video = page.video();
await ctx.close(); // finalizes the webm
const videoPath = await video.path();
await browser.close();

// Extract every frame as jpg, timestamped by ffmpeg itself
execSync(`ffmpeg -y -i "${videoPath}" -vsync 0 -q:v 3 "${outDir}/frame_%04d.jpg"`, { stdio: 'pipe' });
const n = fs.readdirSync(outDir).filter(f => /^frame_\d+\.jpg$/.test(f)).length;
console.log(`video: ${videoPath} | extracted ${n} frames → ${outDir}`);
