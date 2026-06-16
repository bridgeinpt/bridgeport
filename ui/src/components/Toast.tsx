import { toast as sonnerToast } from 'sonner';

/**
 * Toast bridge → Sonner.
 *
 * The app now renders a single Sonner `<Toaster/>` in `main.tsx`. This module
 * keeps the long-standing `useToast()` API alive (46 call sites) by delegating
 * to Sonner, so pages migrate at their own pace. New code should import `toast`
 * directly. The legacy context-based provider was removed in Phase 1 (#244);
 * this whole shim is deleted in Phase 7 teardown (#253).
 */

/** Direct Sonner handle — `toast.success(...)`, `toast.error(...)`, `toast.promise(...)`, … */
export const toast = sonnerToast;

type LegacyToastType = 'success' | 'error' | 'info' | 'warning';

interface LegacyToastInput {
  type: LegacyToastType;
  message: string;
  duration?: number;
}

/**
 * Stable singleton for the legacy toast surface. Defined once at module scope —
 * NOT rebuilt per call — so `useToast()` returns a referentially stable object.
 *
 * This stability matters: an object rebuilt on every render makes any
 * `useCallback`/`useMemo` that lists the toast handle in its deps recompute
 * every render. In components that feed such memos back into state via an
 * effect (e.g. the topology diagram's `setFlowNodes(nodes)` / `setFlowEdges(edges)`
 * sync), that cascades into an infinite render loop — "Maximum update depth
 * exceeded" (React #185). Every method only delegates to the module-level
 * `sonnerToast`, so there's no per-render state to capture.
 */
const legacyToastApi = {
  success: (message: string) => sonnerToast.success(message),
  error: (message: string) => sonnerToast.error(message),
  info: (message: string) => sonnerToast.info(message),
  warning: (message: string) => sonnerToast.warning(message),
  addToast: ({ type, message }: LegacyToastInput) => sonnerToast[type](message),
  removeToast: (id: string | number) => sonnerToast.dismiss(id),
  /** Sonner owns its own render tree; the old in-memory list is no longer surfaced. */
  toasts: [] as never[],
} as const;

/**
 * Back-compat hook mirroring the old ToastContext surface, backed by Sonner.
 * No provider required. Returns the stable {@link legacyToastApi} singleton.
 */
export function useToast() {
  return legacyToastApi;
}
