/**
 * 订阅式播放时钟。
 *
 * `<video>` 的 timeupdate 约 4Hz，如果每次回灌到组件 state，整个播放页（上千行、
 * 上百屏 deck）都会重渲染一次 —— 真机上表现为滑动发涩、发热、掉电。这里改成
 * 外部 store：写入方（VideoSurface 回调）直接 set，只有真正订阅的进度条/时码
 * 通过 useSyncExternalStore 更新，父组件不参与。
 *
 * 每个播放器实例持有一个 Clock（用 useMemo 创建），卸载时 reset，避免跨集残留。
 */
import { useSyncExternalStore } from "react";

export type Clock = {
  /** 当前播放秒数（读快照用，不触发渲染） */
  read: () => number;
  /** 写入新值；变化超过 epsilon 才通知订阅者 */
  write: (t: number) => void;
  /** 订阅（供 useSyncExternalStore 使用） */
  subscribe: (fn: () => void) => () => void;
  /** 归零并通知 */
  reset: () => void;
};

/** 只通知比这更大的变化：同一帧的抖动（如 60fps 的 rAF 回灌）不重复渲染 */
const EPSILON = 0.05;

export function createClock(initial = 0): Clock {
  let value = initial;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  return {
    read: () => value,
    write: (t: number) => {
      if (!Number.isFinite(t)) return;
      if (Math.abs(t - value) < EPSILON) return;
      value = t;
      emit();
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reset: () => {
      if (value === 0) return;
      value = 0;
      emit();
    },
  };
}

/** 订阅时钟当前值：只有调用它的组件会因 timeupdate 重渲染 */
export function useClockValue(clock: Clock): number {
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}

/**
 * 只订阅时钟、只渲染时码的小节点。
 * 放在进度条/时码位置：timeupdate 只会让这一个 <span> 重渲染，
 * 父组件（播放页 / deck）不参与。
 */
export function ClockText({ clock, className }: { clock: Clock; className?: string }) {
  const t = useClockValue(clock);
  return <span className={className}>{fmtClock(t)}</span>;
}

/** 秒 → m:ss，与原 `fmtTime` 保持完全一致（不折算小时，保持界面观感不变） */
export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
