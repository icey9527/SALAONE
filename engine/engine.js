const qs = new URLSearchParams(location.search);
const gameId = qs.get("id") || "default";
let scriptUrl = null;
let assetBase = "";

const elBg0 = document.getElementById("bg0");
const elFade = document.getElementById("fade");
const elText = document.getElementById("textArea");
const elHit = document.getElementById("hitArea");
const btnAuto = document.getElementById("btnAuto");
const btnHome = document.getElementById("btnHome");
const btnReset = document.getElementById("btnReset");

const stage = document.getElementById("stage");
if (stage) stage.focus();

// scriptUrl/assetBase are resolved from games.json by id.

const SAVE_KEY = `vn:${gameId}:auto`;

let ops = [];
let pc = 0;
let fadeMs = 800;
let bgLayers = { 0: null };
let textBuffer = "";

let resumeWait = null;

let bgmAudio = null;
let bgmPath = null;
let pendingBgm = null; // { path, time, shouldPlay }

const urlOkCache = new Map();

let autoMode = false;
let autoTimer = null;
let autoCfg = null;
let charsSincePause = 0;
let typewriterCharDelayMs = 0;
let typewriterIndex = 0;

function normalizeHexColor(s) {
  if (!s) return null;
  const v = String(s).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return "#" + v.toLowerCase();
  if (/^[0-9a-fA-F]{3}$/.test(v)) return "#" + v.toLowerCase();
  return null;
}

function applyGameUiSettings(ui) {
  if (!ui || typeof ui !== "object") return;
  const root = document.documentElement;

  const fontFamily = typeof ui.fontFamily === "string" ? ui.fontFamily : null;
  if (fontFamily) root.style.setProperty("--vn-font-family", fontFamily);

  const fontSizePx = Number(ui.fontSizePx);
  if (Number.isFinite(fontSizePx) && fontSizePx > 0) root.style.setProperty("--vn-font-size", `${fontSizePx}px`);

  const textColor = normalizeHexColor(ui.textColor);
  if (textColor) root.style.setProperty("--vn-text-color", textColor);

  const shadowColor = normalizeHexColor(ui.shadowColor);
  const shadowOffset = Number(ui.shadowOffsetPx);
  if (shadowColor && Number.isFinite(shadowOffset)) {
    const off = shadowOffset;
    // Old VN style: simple right/bottom shadow.
    root.style.setProperty("--vn-shadow", `${off}px ${off}px 0 ${shadowColor}`);
  }

  const lineHeight = Number(ui.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) root.style.setProperty("--vn-line-height", String(lineHeight));

  const fadeMs = Number(ui.typewriterMs);
  if (Number.isFinite(fadeMs) && fadeMs > 0) root.style.setProperty("--vn-fade-ms", `${Math.floor(fadeMs)}ms`);

  const charDelayMs = Number(ui.typewriterCharMs);
  if (Number.isFinite(charDelayMs) && charDelayMs >= 0) typewriterCharDelayMs = Math.floor(charDelayMs);

  if (ui.autoRead && typeof ui.autoRead === "object") {
    const a = ui.autoRead;
    const baseMs = Number(a.baseMs);
    const perCharMs = Number(a.perCharMs);
    const minMs = Number(a.minMs);
    const maxMs = Number(a.maxMs);
    if ([baseMs, perCharMs, minMs, maxMs].every(Number.isFinite)) {
      autoCfg = { baseMs, perCharMs, minMs, maxMs };
    }
  }
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base)) return isPlainObject(over) ? { ...over } : base;
  const out = { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

async function loadGamesData() {
  const url = new URL("./games.json", location.href).toString();
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("games.json load failed: " + r.status);
  const data = await r.json();
  if (Array.isArray(data)) return { default: {}, games: data };
  if (data && typeof data === "object" && Array.isArray(data.games)) return data;
  throw new Error("games.json format invalid");
}

function resolvePathsFromCfg(cfg) {
  // New schema: { asset: "eden", script: "BOOT.txt" } and everything lives under data/
  if (cfg && typeof cfg.asset === "string" && typeof cfg.script === "string") {
    const a = cfg.asset.replace(/^\/+|\/+$/g, "");
    const s = cfg.script.replace(/^\/+/, "");
    return {
      assetBase: `./data/${a}`,
      scriptUrl: `./data/${a}/${s}`,
    };
  }

  // Legacy compatibility
  if (cfg && typeof cfg.assetBase === "string" && typeof cfg.scriptUrl === "string") {
    const ab = cfg.assetBase.replace(/^\/+|\/+$/g, "");
    const su = cfg.scriptUrl.replace(/^\/+/, "");
    return {
      assetBase: ab.startsWith(".") ? ab : "./" + ab,
      scriptUrl: su.startsWith(".") ? su : "./" + su,
    };
  }


  return { assetBase: "", scriptUrl: null };
}

async function loadGameConfigById(id) {
  if (!id) return null;
  const data = await loadGamesData();
  const g = (data.games || []).find(x => x && x.id === id) || null;
  if (!g) return null;
  const merged = deepMerge(data.default || {}, g);
  return merged;
}

function saveAuto(state) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {}
}
function loadAuto() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function clearAuto() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {}
}

function joinPath(a, b) {
  if (!a) return b;
  return `${a}/${b}`.replace(/\/+/g, "/");
}
function assetPath(p) {
  return joinPath(assetBase, p);
}

async function probeUrl(url) {
  if (urlOkCache.has(url)) return urlOkCache.get(url);
  const p = (async () => {
    const head = await fetch(url, { method: "HEAD", cache: "no-store" }).catch(() => null);
    if (head && head.ok) return true;
    const get = await fetch(url, { method: "GET", cache: "no-store" }).catch(() => null);
    if (get && get.ok) return true;
    return false;
  })();
  urlOkCache.set(url, p);
  return p;
}

function variants(name) {
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  const cap = name.length ? name[0].toUpperCase() + name.slice(1) : name;
  return Array.from(new Set([name, lower, cap, upper]));
}

async function resolveImageUrl(logicalPath) {
  const base = assetPath(logicalPath);
  const name = logicalPath.startsWith("bg/") ? logicalPath.slice(3) : logicalPath;
  const isBg = logicalPath.startsWith("bg/");

  const exts = [".png", ".jpg", ".jpeg", ".webp"];
  const tries = [];

  for (const ext of exts) tries.push(base + ext);
  if (isBg) {
    for (const v of variants(name)) {
      for (const ext of exts) tries.push(assetPath("bg/" + v) + ext);
    }
  }

  for (const u of tries) {
    if (await probeUrl(u)) return u;
  }
  return tries[0];
}

async function resolveAudioUrl(logicalPath) {
  const base = assetPath(logicalPath);
  const exts = [".ogg", ".wav", ".mp3"];
  const tries = exts.map(ext => base + ext);
  for (const u of tries) {
    if (await probeUrl(u)) return u;
  }
  return tries[0];
}

function stopBgm() {
  if (bgmAudio) {
    try {
      bgmAudio.pause();
    } catch {}
  }
  bgmAudio = null;
  bgmPath = null;
}

async function tryPlayBgm(logicalPath, startTime) {
  const url = await resolveAudioUrl(logicalPath);
  const a = new Audio(url);
  a.loop = true;
  a.volume = 1.0;
  a.preload = "auto";
  if (typeof startTime === "number" && Number.isFinite(startTime) && startTime > 0) {
    try {
      a.currentTime = startTime;
    } catch {}
  }
  const p = a.play();
  if (p && typeof p.catch === "function") {
    await p.catch(() => {
      // Autoplay may be blocked until user gesture.
      pendingBgm = { path: logicalPath, time: startTime || 0, shouldPlay: true };
      return null;
    });
  }
  if (!pendingBgm) {
    bgmAudio = a;
    bgmPath = logicalPath;
  }
}

function resumePendingBgmIfNeeded() {
  if (!pendingBgm || !pendingBgm.shouldPlay) return;
  const { path, time } = pendingBgm;
  pendingBgm = null;
  tryPlayBgm(path, time).catch(() => {});
}

async function playBgm(logicalPath) {
  if (bgmAudio && bgmPath === logicalPath) return;
  stopBgm();
  bgmPath = logicalPath;
  await tryPlayBgm(logicalPath, 0);
}

async function playSe(logicalPath) {
  const url = await resolveAudioUrl(logicalPath);
  const a = new Audio(url);
  a.loop = false;
  a.volume = 1.0;
  a.play().catch(() => {});
}

function stopAllSound() {
  stopBgm();
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setImg(imgEl, url) {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = () => reject(new Error("Image load failed: " + url));
    imgEl.src = url;
  });
}

async function whiteFadeSwapBg(url) {
  const half = Math.max(0, Math.floor(fadeMs / 2));
  elFade.style.transition = `opacity ${half}ms ease-in-out`;
  elFade.style.opacity = "1";
  await wait(half);
  await setImg(elBg0, url);
  elFade.style.transition = `opacity ${half}ms ease-in-out`;
  elFade.style.opacity = "0";
  await wait(half);
}

function renderText() {
  elText.textContent = textBuffer;
}

function waitForUser() {
  return new Promise(resolve => {
    resumeWait = () => {
      resumeWait = null;
      resolve();
    };

    if (autoMode) {
      const ms = computeAutoDelayMs(charsSincePause);
      charsSincePause = 0;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        // Reset typewriter timing per-page to avoid long blank delays.
        typewriterIndex = 0;
        if (resumeWait) resumeWait();
      }, ms);
    }
  });
}

function continueIfWaiting() {
  resumePendingBgmIfNeeded();
  // Reset typewriter timing per-page to avoid long blank delays.
  typewriterIndex = 0;
  if (resumeWait) resumeWait();
}

elHit?.addEventListener("click", continueIfWaiting);
window.addEventListener("keydown", e => {
  if (e.code === "Space" || e.code === "Enter") continueIfWaiting();
});
elHit?.addEventListener("touchend", e => {
  e.preventDefault();
  continueIfWaiting();
});
btnReset?.addEventListener("click", () => {
  clearAuto();
  location.reload();
});

function computeAutoDelayMs(charCount) {
  if (!autoCfg) return 0;
  const n = Math.max(0, Number(charCount) || 0);
  let ms = autoCfg.baseMs + autoCfg.perCharMs * n;
  ms = Math.max(autoCfg.minMs, ms);
  ms = Math.min(autoCfg.maxMs, ms);
  return Math.floor(ms);
}

function setAutoMode(on) {
  if (!autoCfg) return;
  autoMode = !!on;
  if (btnAuto) btnAuto.classList.toggle("autoOn", autoMode);
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  // If user toggles auto while already waiting, schedule immediately.
  if (autoMode && resumeWait) {
    const ms = computeAutoDelayMs(charsSincePause);
    charsSincePause = 0;
    autoTimer = setTimeout(() => {
      typewriterIndex = 0;
      if (resumeWait) resumeWait();
    }, ms);
  }
}

btnAuto?.addEventListener("click", () => {
  resumePendingBgmIfNeeded();
  setAutoMode(!autoMode);
});
btnHome?.addEventListener("click", () => {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  location.href = u.toString();
});

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      i++;
      let buf = "";
      while (i < s.length) {
        const ch = s[i++];
        if (ch === '"') break;
        if (ch === "\\" && i < s.length) {
          const nxt = s[i++];
          buf += nxt === "n" ? "\n" : nxt;
        } else {
          buf += ch;
        }
      }
      out.push(buf);
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

function parseScript(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(";") || line.startsWith("//") || line.startsWith("[")) continue;
    const m = line.match(/^([A-Z_]+)(?:\s+(.*))?$/);
    if (!m) continue;
    out.push({ op: m[1], args: tokenize(m[2] ?? "") });
  }
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTextFromBuffer() {
  // Restore path: render without per-character animation.
  const html = escapeHtml(textBuffer).replace(/\n/g, "<br>");
  elText.innerHTML = html;
}

function appendTextAnimated(s) {
  if (!s) return;
  const frag = document.createDocumentFragment();
  for (const ch of String(s)) {
    const span = document.createElement("span");
    span.className = "vnCh";
    span.textContent = ch;
    span.style.animationDelay = `${typewriterIndex * typewriterCharDelayMs}ms`;
    frag.appendChild(span);
    typewriterIndex++;
  }
  elText.appendChild(frag);
  charsSincePause += String(s).length;
}

function appendNewline() {
  const br = document.createElement("br");
  elText.appendChild(br);
  // Keep typewriter rhythm across lines.
  typewriterIndex++;
  charsSincePause += 1;
}

function snapshot() {
  return {
    pc,
    fadeMs,
    bgLayers: { ...bgLayers },
    textBuffer,
    bgmPath,
    bgmTime: bgmAudio ? bgmAudio.currentTime : 0,
    bgmPlaying: !!(bgmAudio && !bgmAudio.paused),
    scriptUrl,
    assetBase,
  };
}

async function restore(s) {
  pc = s.pc ?? 0;
  fadeMs = s.fadeMs ?? 800;
  bgLayers = s.bgLayers ?? { 0: null };
  textBuffer = s.textBuffer ?? "";
  renderTextFromBuffer();
  elFade.style.opacity = "0";

  if (bgLayers[0]) {
    const url = await resolveImageUrl(bgLayers[0]);
    try {
      await setImg(elBg0, url);
    } catch {}
  }

  if (s.bgmPath) {
    const shouldPlay = ("bgmPlaying" in s) ? !!s.bgmPlaying : true;
    if (shouldPlay) {
      pendingBgm = { path: s.bgmPath, time: s.bgmTime || 0, shouldPlay: true };
      resumePendingBgmIfNeeded();
    }
  }
}

async function execOne(inst) {
  const { op, args } = inst;

  if (op === "SETSTEP") {
    fadeMs = Math.max(0, Number(args[0] ?? 8) * 100);
    return;
  }

  if (op === "BG") {
    const layer = Number(args[0] ?? 0);
    const path = args[1];
    if (!path) return;
    bgLayers[layer] = path;
    if (layer === 0) {
      const url = await resolveImageUrl(path);
      await whiteFadeSwapBg(url);
    }
    return;
  }

  if (op === "TEXT") {
    const txt = args.length ? args.join(" ") : "";
    textBuffer += txt;
    appendTextAnimated(txt);
    return;
  }

  if (op === "NEWLINE") {
    textBuffer += "\n";
    appendNewline();
    return;
  }

  if (op === "CLEAR") {
    textBuffer = "";
    elText.innerHTML = "";
    charsSincePause = 0;
    typewriterIndex = 0;
    return;
  }

  if (op === "PAUSE") {
    saveAuto(snapshot());
    await waitForUser();
    return;
  }

  if (op === "SE_PLAY") {
    const p = args[0];
    if (!p) return;
    if (p.startsWith("bgm/")) await playBgm(p);
    else await playSe(p);
    return;
  }

  if (op === "SOUND_STOPALL") {
    stopAllSound();
    return;
  }

  if (op === "SOUND_PLAY_TOGGLE") {
    const p = args[0];
    if (!p) return;
    if (p.startsWith("bgm/")) {
      if (bgmAudio && bgmPath === p) {
        if (bgmAudio.paused) bgmAudio.play().catch(() => {});
        else bgmAudio.pause();
      } else {
        await playBgm(p);
      }
    } else {
      await playSe(p);
    }
    return;
  }
}

async function main() {
  const cfg = await loadGameConfigById(gameId);
  if (cfg) {
    if (cfg.title) document.title = cfg.title;
    applyGameUiSettings(cfg.ui);
  }

  const paths = resolvePathsFromCfg(cfg || {});
  scriptUrl = paths.scriptUrl;
  assetBase = paths.assetBase;

  if (!scriptUrl) {
    elText.textContent = "Missing game config for id=" + gameId;
    throw new Error("Missing game config: " + gameId);
  }

  const r = await fetch(scriptUrl, { cache: "no-store" });
  if (!r.ok) throw new Error(`Script load failed: ${scriptUrl} (${r.status})`);
  const scriptText = await r.text();
  ops = parseScript(scriptText);

  const saved = loadAuto();
  if (saved && saved.scriptUrl === scriptUrl && saved.assetBase === assetBase) {
    await restore(saved);
  } else {
    elFade.style.opacity = "0";
    renderTextFromBuffer();
  }

  while (pc < ops.length) {
    const inst = ops[pc];
    await execOne(inst);
    pc++;
  }
  saveAuto(snapshot());
}

main().catch(err => {
  console.error(err);
  elText.textContent = String(err && (err.stack || err.message || err));
});
