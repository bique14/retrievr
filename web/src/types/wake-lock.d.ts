/**
 * `lib.dom.d.ts` in this TypeScript version does not declare the Screen
 * Wake Lock API (`navigator.wakeLock`, `WakeLockSentinel`). Chrome/Edge
 * only; feature-detected at the call site in `useScreenWakeLock`.
 */
interface WakeLockSentinel extends EventTarget {
  readonly released: boolean;
  readonly type: "screen";
  release(): Promise<void>;
  onrelease: ((this: WakeLockSentinel, ev: Event) => unknown) | null;
}

interface WakeLock {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

interface Navigator {
  readonly wakeLock?: WakeLock;
}
