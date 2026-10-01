const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'output');
const recordingsDir = path.join(outputDir, 'recordings');
const syncManifestPath = path.join(outputDir, 'sync_manifest.json');
const viewport = {
  width: Number(process.env.DEMO_VIEWPORT_WIDTH || 2000),
  height: Number(process.env.DEMO_VIEWPORT_HEIGHT || 1125),
};
const recordingSize = {...viewport};
const manifestCandidates = [
  path.join(outputDir, 'timing_manifest.json'),
  path.join(outputDir, 'audio', 'timing_manifest.json'),
];

function readTimings() {
  const manifestPath = manifestCandidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) {
    throw new Error(`Timing manifest not found. Checked: ${manifestCandidates.join(', ')}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function waitDuration(timings, cueId, paddingSec = 0.5) {
  const item = timings[cueId];
  return item ? (item.duration_sec + paddingSec) * 1000 : 2000;
}

let syncClockMs = Date.now();
const syncEvents = [];

function syncNow() {
  return (Date.now() - syncClockMs) / 1000;
}

function writeSyncManifest() {
  fs.writeFileSync(syncManifestPath, JSON.stringify({
    version: 1,
    video_start_epoch_ms: syncClockMs,
    events: syncEvents,
  }, null, 2) + '\n', 'utf8');
}

async function waitForScene(page, scene) {
  if (!scene) {
    return;
  }
  if (scene.urlPattern) {
    await page.waitForURL(new RegExp(scene.urlPattern), {timeout: scene.timeoutMs || 30000});
  }
  let target;
  if (scene.selector) {
    target = page.locator(scene.selector).first();
  } else if (scene.text) {
    target = page.getByText(scene.text, {exact: scene.exactText !== false}).first();
  } else if (scene.role) {
    target = page.getByRole(scene.role, {name: scene.name, exact: scene.exactName !== false}).first();
  }
  if (target) {
    await target.waitFor({state: 'visible', timeout: scene.timeoutMs || 30000});
    await page.waitForTimeout(scene.stableMs || 350);
  }
}

// options.during(at): optional actions (hovers, clicks) to run while the clip plays, so the screen isn't static.
// at(f) waits until fraction f of the cue (0-1), e.g. `async (at) => { await cursor.move(a); await at(0.6); await cursor.move(b); }`.
// A failed action is logged and the cue still runs to its full length.
async function runCue(page, timings, cueId, options = {}) {
  await waitForScene(page, options.scene);
  const event = {cue_id: cueId, file: timings[cueId]?.file || null, start_sec: syncNow(), scene: options.scene || null};
  syncEvents.push(event);
  const t0 = Date.now();
  const total = waitDuration(timings, cueId, options.settleSec ?? 0.35);
  const at = async (f) => {
    const wait = t0 + f * total - Date.now();
    if (wait > 0) {
      await page.waitForTimeout(wait);
    }
  };
  if (options.during) {
    try {
      await options.during(at);
    } catch (error) {
      console.warn(`[${cueId}] action failed: ${error.message.split('\n')[0]}`);
    }
  }
  await at(1);
  event.end_sec = syncNow();
}

function readDemoActions() {
  const raw = process.env.DEMO_ACTIONS;
  if (!raw) {
    return [];
  }
  let actions;
  try {
    actions = JSON.parse(raw);
  } catch (error) {
    throw new Error(`DEMO_ACTIONS must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(actions) || actions.some((action) => !action || typeof action.selector !== 'string')) {
    throw new Error('DEMO_ACTIONS must be an array of objects with a selector string');
  }
  return actions;
}

async function addDemoEnhancements(page) {
  await page.addInitScript(() => {
    const install = () => {
    const root = document.documentElement;
    const cursor = document.createElement('div');
    cursor.id = '__auto-demo-cursor';
    cursor.style.cssText = `
      position: fixed; left: 0; top: 0; width: 24px; height: 30px;
      pointer-events: none; z-index: 2147483647;
      filter: drop-shadow(0 2px 3px rgba(15, 23, 42, 0.45));
      transition: filter 100ms ease-out;
      will-change: transform;
    `;
    cursor.innerHTML = `
      <svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true">
        <path d="M2 2L20 15.5L11.5 16.5L7 27L2 2Z" fill="#ffffff" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="6" cy="6" r="2.2" fill="#2563eb" stroke="#ffffff" stroke-width="1"/>
      </svg>
    `;
    root.appendChild(cursor);

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let frame;
    const renderCursor = () => {
      frame = undefined;
      cursor.style.transform = `translate3d(${x - 2}px, ${y - 2}px, 0)`;
    };
    window.addEventListener('mousemove', (event) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) {
        frame = requestAnimationFrame(renderCursor);
      }
    }, { passive: true });
    window.addEventListener('mousedown', () => {
      cursor.style.filter = 'drop-shadow(0 2px 3px rgba(37, 99, 235, 0.8))';
    }, true);
    window.addEventListener('mouseup', () => {
      cursor.style.filter = 'drop-shadow(0 2px 3px rgba(15, 23, 42, 0.45))';
    }, true);
    renderCursor();

    window.addEventListener('click', (event) => {
      const ripple = document.createElement('div');
      ripple.style.cssText = `
        position: fixed; left: ${event.clientX - 18}px; top: ${event.clientY - 18}px;
        width: 36px; height: 36px; border-radius: 50%;
        background: rgba(37, 99, 235, 0.18); border: 2px solid rgba(37, 99, 235, 0.9);
        box-shadow: 0 0 0 8px rgba(37, 99, 235, 0.12);
        pointer-events: none; z-index: 2147483646;
        transition: transform 420ms ease-out, opacity 420ms ease-out;
        transform: scale(0.55); opacity: 1;
      `;
      root.appendChild(ripple);
      requestAnimationFrame(() => {
        ripple.style.transform = 'scale(1.65)';
        ripple.style.opacity = '0';
      });
      setTimeout(() => ripple.remove(), 440);
    }, true);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
      install();
    }
  });
}

async function smoothScrollTo(page, target) {
  await target.evaluate((element) => {
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  });
  await page.waitForTimeout(650);
}

// Human-like pointer, tuned against cursor tracks from a hand-recorded screen capture:
// fast launch and long deceleration (speed peaks ~40% in), a slight arc, a primary move that lands a little
// short of where it's aiming, then one small correction. It aims off-center on the target and holds still once there.
const rand = (a, b) => a + Math.random() * (b - a);
// Minimum-jerk position profile with time warped so peak speed comes early (~0.4 instead of 0.5).
const ease = (t) => { const u = Math.pow(t, 0.8); return 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5; };

function createPlaywrightCursor(page) {
  let currentPoint = { x: viewport.width / 2, y: viewport.height / 2 };

  async function stroke(to, durationSec, bowFrac) {
    const from = currentPoint;
    const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy) || 1;
    // Quadratic Bezier with its control point pushed sideways -> gentle wrist arc.
    const side = bowFrac * dist;
    const ctrl = { x: (from.x + to.x) / 2 - dy / dist * side, y: (from.y + to.y) / 2 + dx / dist * side };
    const t0 = Date.now(), ms = durationSec * 1000;
    for (;;) {
      const t = Math.min(1, (Date.now() - t0) / ms), s = ease(t);
      const x = (1 - s) ** 2 * from.x + 2 * (1 - s) * s * ctrl.x + s * s * to.x;
      const y = (1 - s) ** 2 * from.y + 2 * (1 - s) * s * ctrl.y + s * s * to.y;
      await page.mouse.move(x, y);
      if (t >= 1) break;
      await page.waitForTimeout(16);
    }
    currentPoint = to;
  }

  return {
    async move(target) {
      await smoothScrollTo(page, target);
      const box = await target.boundingBox();
      if (!box) {
        throw new Error('Unable to resolve the target bounding box');
      }
      // Where the eye is aiming: toward the start of the label, never dead center.
      const aim = {
        x: box.x + Math.min(box.width * rand(0.15, 0.6), rand(20, 140)),
        y: box.y + box.height * rand(0.35, 0.75),
      };
      const dx = aim.x - currentPoint.x, dy = aim.y - currentPoint.y, dist = Math.hypot(dx, dy);
      if (dist < 4) return;
      await page.waitForTimeout(rand(60, 180)); // reaction time before the hand moves
      const duration = (0.12 + 0.085 * Math.log2(1 + dist / 30)) * rand(0.85, 1.2);
      const bow = rand(0.03, 0.12) * (Math.random() < 0.5 ? -1 : 1);
      if (dist < 70) {
        await stroke(aim, duration, bow);
        return;
      }
      // Primary ballistic move lands short and a little off-line, then a quick corrective nudge.
      const under = Math.min(40, dist * rand(0.03, 0.09)), off = Math.max(-18, Math.min(18, dist * rand(-0.035, 0.035)));
      const ux = dx / dist, uy = dy / dist;
      await stroke({ x: aim.x - ux * under - uy * off, y: aim.y - uy * under + ux * off }, duration, bow);
      await page.waitForTimeout(rand(70, 200));
      await stroke(aim, rand(0.1, 0.18), rand(-0.08, 0.08));
    },
    async click(target) {
      await this.move(target);
      await page.waitForTimeout(rand(90, 200));
      await page.mouse.down();
      await page.waitForTimeout(rand(60, 110));
      await page.mouse.up();
    },
  };
}

async function runProductWorkflow(page, timings, cursor) {
  const demoUrl = process.env.DEMO_URL;
  if (!demoUrl) {
    throw new Error('Set DEMO_URL before running this template, or replace runProductWorkflow with your workflow.');
  }
  await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });
  const actions = readDemoActions();
  if (actions.length === 0) {
    await runCue(page, timings, 'cue_01', {scene: process.env.DEMO_INITIAL_SCENE ? JSON.parse(process.env.DEMO_INITIAL_SCENE) : null});
    return;
  }
  for (const action of actions) {
    const target = page.locator(action.selector).first();
    await waitForScene(page, action.waitForBefore || {selector: action.selector});
    await target.waitFor({ state: 'visible' });
    await cursor.click(target);
    if (action.cue) {
      await runCue(page, timings, action.cue, {scene: action.waitForAfter || action.waitForBefore || {selector: action.selector}});
    }
  }
}

async function runDemo() {
  const timings = readTimings();
  fs.mkdirSync(recordingsDir, { recursive: true });
  const launchOptions = {
    headless: process.env.DEMO_HEADLESS === '1',
    args: ['--force-device-scale-factor=1'],
  };
  const contextOptions = {
    viewport,
    recordVideo: {
      dir: recordingsDir,
      size: recordingSize,
    },
  };
  // DEMO_USER_DATA_DIR reuses a persistent Chromium profile, so a sign-in done once (by hand, in that
  // profile) carries into the recording. Close any other browser using the profile first; it is locked while open.
  const userDataDir = process.env.DEMO_USER_DATA_DIR;
  const browser = userDataDir ? null : await chromium.launch(launchOptions);
  const context = userDataDir
    ? await chromium.launchPersistentContext(path.resolve(userDataDir), {...launchOptions, ...contextOptions})
    : await browser.newContext(contextOptions);
  const startupPages = context.pages();
  const page = await context.newPage();
  for (const startupPage of startupPages) {
    await startupPage.close();
  }
  syncClockMs = Date.now();
  const video = page.video();
  const cursor = createPlaywrightCursor(page);
  await addDemoEnhancements(page);
  let workflowError;

  try {
    await runProductWorkflow(page, timings, cursor);
  } catch (error) {
    workflowError = error;
  } finally {
    writeSyncManifest();
    await context.close();
    await browser?.close();
  }

  if (video) {
    const sourcePath = await video.path();
    const pointerPath = path.join(recordingsDir, 'latest_recording.txt');
    fs.writeFileSync(pointerPath, `${sourcePath}\n`, 'utf8');
    console.log(`Recording saved: ${sourcePath}`);
  }
  if (workflowError) {
    throw workflowError;
  }
}

runDemo().catch((error) => {
  console.error('Execution failed:', error);
  process.exit(1);
});
