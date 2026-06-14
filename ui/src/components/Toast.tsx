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
 * Back-compat hook mirroring the old ToastContext surface, backed by Sonner.
 * No provider required.
 */
export function useToast() {
  return {
    success: (message: string) => sonnerToast.success(message),
    error: (message: string) => sonnerToast.error(message),
    info: (message: string) => sonnerToast.info(message),
    warning: (message: string) => sonnerToast.warning(message),
    addToast: ({ type, message }: LegacyToastInput) => sonnerToast[type](message),
    removeToast: (id: string | number) => sonnerToast.dismiss(id),
    /** Sonner owns its own render tree; the old in-memory list is no longer surfaced. */
    toasts: [] as never[],
  };
}
