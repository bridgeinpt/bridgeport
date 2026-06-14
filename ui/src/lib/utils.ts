import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with Tailwind-aware conflict resolution.
 *
 * The shadcn/ui convention helper — kept deliberately separate from
 * `@/lib/helpers.ts` (app utilities). `clsx` handles conditional/array class
 * inputs; `twMerge` de-dupes conflicting Tailwind utilities (last wins).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
