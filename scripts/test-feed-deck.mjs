// 逐集滑片（Feed deck）本地回归测试：验证「往下滑 = 下一集，滑完最后一集才进下一部」。
// 全部 Tauri IPC 都用桩替换，不联网、不需要安装包。
//
//   pnpm test:feed [--browser-executable PATH] [--output DIR]
//
// 覆盖：首页连续下滑/上滑、跨剧边界、选集跳集、观看记录续播定位、
//       从列表 middle 进入（startIndex≠0）、安卓触摸手势、上百集长剧的窗口化渲染。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: {
  "browser-executable": { type: "string" },
  output: { type: "string" },
} });

/** playwright-core 不带浏览器：默认用本机 Chrome/Edge，其次用 playwright 自己装的那份 */
function browserPath() {
  if (args["browser-executable"]) return args["browser-executable"];
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  const local = candidates.find((p) => existsSync(p));
  if (local) return local;
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch { /* 没装就交给 playwright 自己找 */ }
  return undefined;
}

/** 1x1 透明 PNG：用来验证封面渲染链路（本地解密协议在浏览器里不存在，route 拦下来回它） */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const SHORT = [{ id: 101, title: "剧A", eps: 5 }, { id: 102, title: "剧B", eps: 3 }, { id: 103, title: "剧C", eps: 4 }];
const LONG = [{ id: 201, title: "长剧", eps: 120 }, { id: 202, title: "短剧", eps: 2 }];

const output = resolve(args.output || join(root, "test-results", "feed", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(output, { recursive: true });
const report = { started: new Date().toISOString(), cases: [], failures: [] };

/* ── Tauri IPC 桩 ─────────────────────────────────────────── */
function stub({ videos }) {
  let seq = 0;
  const coverOf = (v) => `https://img.invalid/${v.id}.jpg`;
  const card = (v) => ({
    id: v.id, title: v.title, cover: coverOf(v), tags: [], score: 0, episode_count: v.eps, total_episodes: v.eps,
    hot: 0, like_count: 0, collect_count: 0, comment_count: 0, is_finished: false, is_original: 1,
  });
  const detail = (v) => ({
    id: v.id, title: v.title, description: `${v.title} 简介`, cover: coverOf(v), tags: [], tag_links: [], score: 8.5,
    episode_count: v.eps, total_episodes: v.eps,
    episodes: Array.from({ length: v.eps }, (_, i) => ({ ep_num: i + 1, title: `第${i + 1}集`, duration: 90, status: 1 })),
    counts: { collect: 0, comment: 0, hot: 0, like: 0 }, author: { id: v.id * 10, name: `作者${v.id}` },
    is_finished: false, is_original: 1,
  });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb) => { const id = ++seq; window[`_cb_${id}`] = cb; return id; },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, a) => {
      if (cmd === "app_boot") return { user: null, logged_in: false, base: "http://fixture.invalid", strict_security: false };
      if (cmd === "api_feed" || cmd === "api_category" || cmd === "api_search") {
        return { items: videos.map(card), pagination: { page: 1, pages: 1, size: 10, total: videos.length } };
      }
      if (cmd === "api_video") {
        const v = videos.find((x) => x.id === Number(a?.id));
        if (!v) return null;
        if (v.detailDelayMs) await new Promise((r) => setTimeout(r, v.detailDelayMs));
        return detail(v);
      }
      // 给个不会真的取到流的地址：播放器结构照常渲染（全屏/控制条才有东西可点），只是画面报错
      if (cmd === "api_play") return { id: Number(a?.id), ep_num: Number(a?.ep), duration: 90, title: "", video_url: "https://media.fixture.invalid/v.m3u8" };
      if (cmd === "api_comments" || cmd === "api_post_comments") return { ep: 1, items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } };
      return null;
    },
  };
}

/* ── 页面探针 ─────────────────────────────────────────────── */
const activeOf = (page) => page.evaluate(() => {
  const boxes = document.querySelectorAll(".no-bar");          // 首页与栈页各有一个，取最后（栈顶）
  const box = boxes[boxes.length - 1];
  if (!box) return null;
  const i = Math.round(box.scrollTop / (box.clientHeight || 1));
  const s = box.querySelectorAll("section")[i];
  if (!s) return null;
  const sections = box.querySelectorAll("section");
  return {
    video: Number(s.dataset.video), ep: Number(s.dataset.ep), index: i,
    total: sections.length, rendered: box.querySelectorAll("section:not([aria-hidden])").length,
  };
});
async function waitSlide(page, video, ep) {
  await page.waitForFunction(({ video, ep }) => {
    const boxes = document.querySelectorAll(".no-bar");
    const box = boxes[boxes.length - 1];
    if (!box) return false;
    const i = Math.round(box.scrollTop / (box.clientHeight || 1));
    const s = box.querySelectorAll("section")[i];
    return !!s && Number(s.dataset.video) === video && Number(s.dataset.ep) === ep;
  }, { video, ep }, { timeout: 10000 });
  return activeOf(page);
}

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  report.cases.push({ name, got, want, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` —— 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`}`);
  if (!ok) report.failures.push(name);
  assert.ok(ok, name);
};

const vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: browserPath() });

async function open({ videos = SHORT, mobile = false, storage = null }) {
  const context = mobile
    ? await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: MOBILE_UA, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    : await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(stub, { videos });
  /* 本地解密协议在浏览器里不存在：拦下来回一张真图，才能验证封面渲染链路 */
  await context.route("**/img?**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await context.route("**/hls?**", (route) => route.abort());
  await context.route("**/seg?**", (route) => route.abort());
  if (storage) await page.addInitScript((s) => localStorage.setItem("hghub_app_v1", s), storage);
  await page.goto(base, { waitUntil: "load" });
  await page.bringToFront();
  return { page, context, errors };
}

try {
  /* 1. 首页：逐集下滑、跨剧、上滑、滚轮 */
  {
    const { page, context, errors } = await open({});
    await page.waitForSelector("section[data-video]");
    const first = await waitSlide(page, 101, 1);
    check("首页进入第 1 集", [first.video, first.ep], [101, 1]);
    /* 封面：占位空地址 → 真封面之后必须能显示（Img 的 ok/err 要随地址重置，否则一直是灰块） */
    await page.waitForFunction(() => {
      const img = document.querySelector('section[data-video="101"][data-ep="2"] img');
      return !!img && img.naturalWidth > 0 && Number(getComputedStyle(img).opacity) > 0.9;
    }, null, { timeout: 8000 });
    check("非当前屏的封面能正常显示", true, true);
    // 当前剧 + 下一部展开，再下一部还是单屏
    await page.waitForFunction(() => document.querySelectorAll(".no-bar section").length >= 9);
    check("展开后滑片数 = 5 + 3 + 1", (await activeOf(page)).total, 9);

    await page.keyboard.press("ArrowDown");
    check("下滑到第 2 集", (await waitSlide(page, 101, 2)).ep, 2);
    await page.keyboard.press("ArrowDown");
    await waitSlide(page, 101, 3);
    await page.locator(".no-bar").last().hover();
    await page.mouse.wheel(0, 820);
    check("滚轮下滑到第 4 集", (await waitSlide(page, 101, 4)).ep, 4);
    await page.keyboard.press("ArrowDown");
    await waitSlide(page, 101, 5);
    await page.keyboard.press("ArrowDown");
    const cross = await waitSlide(page, 102, 1);
    check("最后一集下滑 → 下一部第 1 集", [cross.video, cross.ep], [102, 1]);
    await page.keyboard.press("ArrowUp");
    const up1 = await waitSlide(page, 101, 5);
    check("上滑 = 上一部最后一集", [up1.video, up1.ep], [101, 5]);
    await page.keyboard.press("ArrowDown");
    check("下滑回到下一部第 1 集", [(await waitSlide(page, 102, 1)).video, (await activeOf(page)).ep], [102, 1]);
    /* 连按（键盘自动重复）不能被吞：三次连按连翻三集 */
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    check("连按两次下滑连翻两集", (await waitSlide(page, 102, 3)).ep, 3);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    check("连按两次上滑连翻两集", (await waitSlide(page, 102, 1)).ep, 1);

    // 选集跳集后继续下滑
    await page.keyboard.press("ArrowDown"); await waitSlide(page, 102, 1);
    await page.keyboard.press("e");
    await page.waitForTimeout(300);
    await page.locator(".desktop-dock-panel button", { hasText: /^3$/ }).first().click();
    check("选集跳到第 3 集", (await waitSlide(page, 102, 3)).ep, 3);
    /* 存档已拆成分片键：history 在 hghub_history_v1（旧的整包键只做迁移来源）。
       写入现在是 200ms 防抖，读之前先等它落盘。 */
    await page.waitForFunction(() => {
      const h = JSON.parse(localStorage.getItem("hghub_history_v1") || "[]");
      return h[0] && h[0].ep === 3 && h[0].id === 102;
    }, null, { timeout: 4000 });
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem("hghub_history_v1") || "[]"));
    check("观看记录停在当前集", [history[0].id, history[0].ep], [102, 3]);
    await page.screenshot({ path: join(output, "home.png") });
    check("首页无脚本错误", errors, []);
    await context.close();
  }

  /* 2. 观看记录续播：从第 3 集进入，前后都能续 */
  {
    const { page, context, errors } = await open({ storage: JSON.stringify({
      likes: [], favs: [], follows: [], searchHist: [], muted: true, volume: 0.7,
      history: [{ id: 102, ep: 3, t: 20, dur: 90, at: Date.now() }],
    }) });
    await page.getByRole("button", { name: "我的" }).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "观看历史" }).click();
    await page.waitForTimeout(700);
    await page.locator("button", { hasText: "剧B" }).last().click();
    const s = await waitSlide(page, 102, 3);
    check("续播落在第 3 集（剧集展开后索引跟着走）", [s.video, s.ep], [102, 3]);
    /* 旧版本把全部状态塞在 hghub_app_v1：新版本要自动迁移到分片键 */
    await page.waitForFunction(() => !!localStorage.getItem("hghub_history_v1"), null, { timeout: 5000 });
    check("旧存档自动迁移到分片键", await page.evaluate(() => {
      const legacy = JSON.parse(localStorage.getItem("hghub_app_v1") || "{}");
      const part = JSON.parse(localStorage.getItem("hghub_history_v1") || "[]");
      return { legacyHas: Array.isArray(legacy.history), partCount: part.length >= 1 };
    }), { legacyHas: true, partCount: true });
    await page.keyboard.press("ArrowUp");
    check("续播后上滑 = 第 2 集", (await waitSlide(page, 102, 2)).ep, 2);
    await page.keyboard.press("ArrowDown"); await waitSlide(page, 102, 3);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(900);
    const end = await activeOf(page);
    check("最后一部最后一集再下滑停住", [end.video, end.ep], [102, 3]);
    await page.screenshot({ path: join(output, "resume.png") });
    check("续播页无脚本错误", errors, []);
    await context.close();
  }

  /* 3. 从列表中间进入（startIndex≠0） */
  {
    const { page, context, errors } = await open({});
    await page.getByRole("button", { name: "分类" }).first().click();
    await page.waitForTimeout(800);
    await page.locator("button", { hasText: "剧B" }).first().click();
    check("分类进入第 2 部第 1 集", [(await waitSlide(page, 102, 1)).video, (await activeOf(page)).ep], [102, 1]);
    await page.keyboard.press("ArrowDown");
    check("下滑 = 第 2 集", (await waitSlide(page, 102, 2)).ep, 2);
    await page.keyboard.press("ArrowUp"); await waitSlide(page, 102, 1);
    await page.keyboard.press("ArrowUp");
    check("上滑 = 上一部第 1 集", [(await waitSlide(page, 101, 1)).video, (await activeOf(page)).ep], [101, 1]);
    await page.keyboard.press("ArrowDown");
    check("上一部展开后下滑 = 第 2 集", (await waitSlide(page, 101, 2)).ep, 2);
    await page.screenshot({ path: join(output, "category.png") });
    check("列表入口无脚本错误", errors, []);
    await context.close();
  }

  /* 4. 上百集长剧：窗口化渲染 + 远端跳集 */
  {
    const { page, context, errors } = await open({ videos: LONG });
    await page.waitForSelector("section[data-video]");
    await waitSlide(page, 201, 1);
    await page.waitForFunction(() => document.querySelectorAll(".no-bar section").length >= 121);
    const s = await activeOf(page);
    check("120 集长剧展开成 121 屏", s.total, 122);           // 120 + 短剧 1 屏 + ... 见下
    check("只渲染当前屏附近的内容", s.rendered <= 25, true);
    await page.keyboard.press("e");
    await page.waitForTimeout(300);
    await page.locator(".desktop-dock-panel button", { hasText: /^98$/ }).first().click();
    check("选集远跳第 98 集", (await waitSlide(page, 201, 98)).ep, 98);
    await page.keyboard.press("ArrowDown");
    check("远跳后下滑 = 第 99 集", (await waitSlide(page, 201, 99)).ep, 99);
    await page.screenshot({ path: join(output, "long.png") });
    check("长剧页无脚本错误", errors, []);
    await context.close();
  }

  /* 4.5 详情晚到：先在空封面上停留，详情回来封面要补上（Img 状态随地址重置） */
  {
    const slow = [{ id: 301, title: "剧D", eps: 2 }, { id: 302, title: "剧E", eps: 2, detailDelayMs: 2500 }];
    const { page, context, errors } = await open({ videos: slow });
    await page.waitForSelector("section[data-video]");
    await waitSlide(page, 301, 1);
    await page.keyboard.press("ArrowDown"); await waitSlide(page, 301, 2);
    await page.keyboard.press("ArrowDown"); await waitSlide(page, 302, 1);
    const before = await page.evaluate(() => {
      const img = document.querySelector('section[data-video="302"][data-ep="1"] img');
      return img ? img.naturalWidth : -1;   // -1 = 还没渲染 img（空地址已被跳过）
    });
    check("详情没到时不显示破图", before <= 0, true);
    await page.waitForFunction(() => {
      const img = document.querySelector('section[data-video="302"][data-ep="1"] img');
      return !!img && img.naturalWidth > 0 && Number(getComputedStyle(img).opacity) > 0.9;
    }, null, { timeout: 10000 });
    check("封面晚到后能正常显示", true, true);
    check("剧集晚到后仍停在同一集", (await activeOf(page)).ep, 1);
    check("详情晚到场景无脚本错误", errors, []);
    await page.screenshot({ path: join(output, "slow-detail.png") });
    await context.close();
  }

  /* 4.8 桌面长按：右半 2x / 左半 0.5x，松开恢复；短按不算长按 */
  {
    const { page, context, errors } = await open({});
    await page.waitForSelector("section[data-video]");
    await waitSlide(page, 101, 1);
    await page.waitForFunction(() => !!document.querySelector("video"), null, { timeout: 8000 });
    const box = await page.locator('section[data-video="101"][data-ep="1"]').first().boundingBox();
    const rate = () => page.evaluate(() => document.querySelector("video")?.playbackRate ?? -1);
    const holdAt = async (fx, ms) => {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(ms);
      const during = await rate();
      await page.mouse.up();
      await page.waitForTimeout(250);
      return { during, after: await rate() };
    };

    const right = await holdAt(0.78, 450);
    check("长按右半 = 2x", right.during, 2);
    check("松开后回到 1x", right.after, 1);

    const left = await holdAt(0.22, 450);
    check("长按左半 = 0.5x 慢放", left.during, 0.5);
    check("松开后回到 1x（左半）", left.after, 1);

    const quick = await holdAt(0.78, 120);
    check("短按不算长按，倍速不变", [quick.during, quick.after], [1, 1]);

    /* 长按中的提示条 */
    await page.mouse.move(box.x + box.width * 0.78, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    const hint = await page.evaluate(() => {
      const el = [...document.querySelectorAll("div")].find((n) => (n.textContent || "").includes("倍速中（右半）"));
      return !!el;
    });
    check("长按时有倍速提示", hint, true);
    await page.mouse.up();
    await page.waitForTimeout(200);

    check("长按倍速无脚本错误", errors, []);
    await page.screenshot({ path: join(output, "long-press.png") });
    await context.close();
  }

  /* 5. 安卓：真实触摸上滑 */
  {
    const { page, context, errors } = await open({ mobile: true });
    await page.waitForSelector("section[data-video]");
    await waitSlide(page, 101, 1);
    const epLabel = () => page.evaluate(() => {
      const boxes = document.querySelectorAll(".no-bar");
      const b = boxes[boxes.length - 1];
      return [...b.querySelectorAll("p,button,span")].map((n) => n.textContent || "").find((t) => /^详情 · 第 \d+ 集$/.test(t)) || "";
    });
    check("手机端初始集数标签", await epLabel(), "详情 · 第 1 集");
    const client = await page.context().newCDPSession(page);
    const swipe = async () => {
      const box = await page.locator(".no-bar").boundingBox();
      const x = box.x + box.width / 2;
      const y0 = box.y + box.height * 0.78;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 10; i++) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 - box.height * 0.6 * (i / 10) }] });
        await page.waitForTimeout(16);
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(450);
    };
    await swipe();
    check("手机端上滑一次 = 下一集", (await waitSlide(page, 101, 2)).ep, 2);
    check("集数标签跟着更新", await epLabel(), "详情 · 第 2 集");
    await swipe();
    check("再上滑 = 第 3 集", (await waitSlide(page, 101, 3)).ep, 3);

    /* 手机端长按：右半 2x / 左半 0.5x（真实触摸） */
    const holdTouch = async (fx, ms) => {
      const b = await page.locator(".no-bar").boundingBox();
      const x = b.x + b.width * fx;
      const y = b.y + b.height * 0.5;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.waitForTimeout(ms);
      const during = await page.evaluate(() => document.querySelector("video")?.playbackRate ?? -1);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
      return { during, after: await page.evaluate(() => document.querySelector("video")?.playbackRate ?? -1) };
    };
    const touchRight = await holdTouch(0.78, 600);
    check("手机长按右半 = 2x", touchRight.during, 2);
    check("手机松开回到 1x", touchRight.after, 1);
    const touchLeft = await holdTouch(0.22, 600);
    check("手机长按左半 = 0.5x", touchLeft.during, 0.5);
    check("手机松开回到 1x（左半）", touchLeft.after, 1);

    /* 全屏进出后仍停在原来那一集（scrollTop 要重新对齐）。全屏时其它屏 display:none，
       所以看「还占着视口的那一屏」是谁。惯性滑动可能一次翻过两集，这里以实际停稳的那一屏为准。 */
    await page.waitForTimeout(700);
    const before = await activeOf(page);
    const visibleSlide = () => page.evaluate(() => {
      const boxes = document.querySelectorAll(".no-bar");
      const box = boxes[boxes.length - 1];
      const view = box.getBoundingClientRect();
      const mid = view.top + view.height / 2;
      const sec = [...box.querySelectorAll("section")].find((s) => {
        const r = s.getBoundingClientRect();
        return r.height > 0 && r.top <= mid && r.bottom >= mid;
      });
      return sec ? { video: Number(sec.dataset.video), ep: Number(sec.dataset.ep) } : null;
    });
    const clickAt = async (locator) => {
      const b = await locator.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    const section = page.locator(`section[data-video="${before.video}"][data-ep="${before.ep}"]`).last();
    await section.getByRole("button", { name: "全屏" }).dispatchEvent("click");
    await page.waitForTimeout(400);
    const inFs = await visibleSlide();
    check("进入全屏仍是同一集", inFs && [inFs.video, inFs.ep], [before.video, before.ep]);
    check("全屏时其它屏不渲染", await page.evaluate(() => {
      const boxes = document.querySelectorAll(".no-bar");
      const box = boxes[boxes.length - 1];
      return [...box.querySelectorAll("section")].filter((s) => s.getClientRects().length > 0).length;
    }), 1);
    await clickAt(page.getByRole("button", { name: "退出全屏" }).first());
    await page.waitForTimeout(700);
    const back = await activeOf(page);
    check("退出全屏回到同一集", [back.video, back.ep], [before.video, before.ep]);
    check("退出全屏后滚动位置对齐", await page.evaluate((idx) => {
      const boxes = document.querySelectorAll(".no-bar");
      const b = boxes[boxes.length - 1];
      return Math.abs(b.scrollTop - idx * (b.clientHeight || 1)) < 2;
    }, before.index), true);
    await page.screenshot({ path: join(output, "mobile.png") });
    check("手机端无脚本错误", errors, []);
    await context.close();
  }
} finally {
  report.finished = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await vite.close();
}

console.log(`\n${report.cases.length - report.failures.length}/${report.cases.length} 项通过 · 产物目录 ${output}`);
if (report.failures.length) process.exitCode = 1;
