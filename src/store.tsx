import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, platform as envPlatform } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { User } from "./types";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
};

const LS = "hghub_app_v1";
/** 分片存储：播放时每 5 秒写一次历史、拖音量每帧写一次，全量写一个大 JSON 会卡主线程 */
const LS_PARTS = {
  prefs: "hghub_prefs_v1",
  likes: "hghub_likes_v1",
  favs: "hghub_favs_v1",
  follows: "hghub_follows_v1",
  history: "hghub_history_v1",
  search: "hghub_search_v1",
} as const;

const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [],
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

/** 存档里的数组/数字可能被旧版本或半截写入弄坏：逐字段校验，坏值回退默认，避免渲染期 TypeError 白屏 */
const numList = (raw: unknown): number[] =>
  Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/** 读一个分片键；没有/坏了就返回兜底值 */
function readPart<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadPersist(): Persist {
  /* 旧版本把全部状态塞在 `hghub_app_v1` 一个键里：先当兜底读，再被分片覆盖 ——
     首次启动新版本即完成迁移，老用户的收藏/历史不会丢 */
  let legacy: Partial<Persist> = {};
  try {
    const raw = localStorage.getItem(LS);
    if (raw) legacy = JSON.parse(raw) as Partial<Persist>;
  } catch { /* 存档损坏就当没有，全部回退默认值 */ }

  const prefs = readPart<{ muted?: unknown; muteOnStartup?: unknown; volume?: unknown } | null>(LS_PARTS.prefs, null);
  const muteOnStartup = (prefs ? prefs.muteOnStartup : legacy.muteOnStartup) !== false;
  const rawVolume = Number(prefs && prefs.volume !== undefined ? prefs.volume : legacy.volume);
  const volume = Number.isFinite(rawVolume) ? Math.max(0, Math.min(1, rawVolume)) : DEFAULTS.volume;
  const muted = prefs && prefs.muted !== undefined ? prefs.muted === true : legacy.muted === true;

  return {
    likes: numList(readPart<unknown>(LS_PARTS.likes, legacy.likes)),
    favs: numList(readPart<unknown>(LS_PARTS.favs, legacy.favs)),
    follows: numList(readPart<unknown>(LS_PARTS.follows, legacy.follows)),
    history: normalizeHistory(readPart<unknown>(LS_PARTS.history, legacy.history)).slice(0, 80),
    searchHist: strList(readPart<unknown>(LS_PARTS.search, legacy.searchHist)).slice(0, 12),
    volume,
    muteOnStartup,
    muted: muteOnStartup || muted,
  };
}

function readTheme(): Theme {
  try {
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 清屏模式（单击屏幕消除所有控件，只保留纯视频内容） */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghub_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  /* 存档改为分片 + 防抖写入，见下面 flushWrites（这里不再全量写 hghub_app_v1） */

  useEffect(() => {
    api.boot()
      .then((r) => {
        if (r.user && (r.user as User).id) setUser(r.user as User);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => { /* 离线也能用 */ });
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  /* —— 分片 + 防抖落盘 ——
     播放时每 5 秒写一次历史、拖音量每帧都在改状态；如果每次都 stringify 整个存档再同步写，
     会在主线程上反复做全量序列化。这里只写变化的切片，并合并 200ms 内的多次改动。 */
  const pendingWrites = useRef<Record<string, string>>({});
  const lastWritten = useRef<Record<string, string>>({});
  const flushTimer = useRef<number | undefined>(undefined);
  const quotaWarned = useRef(false);

  const flushWrites = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    const pending = pendingWrites.current;
    pendingWrites.current = {};
    for (const [key, text] of Object.entries(pending)) {
      try {
        localStorage.setItem(key, text);
      } catch {
        let recovered = false;
        /* 配额满：历史先砍到 20 条再试一次；仍然失败就提示一次，
           否则用户会以为收藏成功了，其实重启后没了 */
        if (key === LS_PARTS.history) {
          try {
            const entries = JSON.parse(text) as unknown[];
            localStorage.setItem(key, JSON.stringify(entries.slice(0, 20)));
            recovered = true;
          } catch { /* ignore */ }
        }
        if (!recovered && !quotaWarned.current) {
          quotaWarned.current = true;
          toast("本地存储已满，部分收藏/历史可能没有保存");
        }
      }
    }
  }, [toast]);

  useEffect(() => {
    const slices: [string, unknown][] = [
      [LS_PARTS.prefs, { muted: p.muted, muteOnStartup: p.muteOnStartup, volume: p.volume }],
      [LS_PARTS.likes, p.likes],
      [LS_PARTS.favs, p.favs],
      [LS_PARTS.follows, p.follows],
      [LS_PARTS.history, p.history],
      [LS_PARTS.search, p.searchHist],
    ];
    let dirty = false;
    for (const [key, value] of slices) {
      const text = JSON.stringify(value);
      if (lastWritten.current[key] === text) continue;
      lastWritten.current[key] = text;
      pendingWrites.current[key] = text;
      dirty = true;
    }
    if (!dirty || flushTimer.current) return;
    flushTimer.current = window.setTimeout(flushWrites, 200);
  }, [p, flushWrites]);

  /* 进后台/退出前把攒着的那点改动写掉（安卓进程被杀时尤其重要） */
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushWrites(); };
    window.addEventListener("pagehide", flushWrites);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      flushWrites();
      window.removeEventListener("pagehide", flushWrites);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flushWrites]);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); setCleanState(false); }, []);
  const push = useCallback((pg: PageInput) => {
    setCleanState(false);
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => {
    setCleanState(false);
    setStack((s) => s.slice(0, -1));
  }, []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: epChanged ? 0 : (t ?? prev?.t ?? 0),
        dur: dur ?? prev?.dur ?? 0,
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setUser(null);
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      if (!next) {
        invoke("set_orientation", { landscape: false }).catch(() => {});
        try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, setTheme: setThemeState,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume,
    theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast,
  }), [theme, tab, setTab, stack, push, pop, user, loginOpen, logout,
    p, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    setMuted, setMuteOnStartup, setVolume, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, theater, setTheater, fs, setFs, clean, setClean]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
