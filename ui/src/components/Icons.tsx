/**
 * Single icon source: lucide-react re-exported under the names this app has
 * always used, so the hundreds of `<XIcon />` call sites compile unchanged
 * (#245). lucide gives every icon a consistent 24px / strokeWidth-2 baseline,
 * which retires the old hand-rolled SVGs — including the PuzzleIcon 1.75 stroke
 * and the Sync/Refresh + Deploy/Upload duplicates.
 *
 * Mapping notes (name → lucide) where the glyph isn't a 1:1 of the old one:
 *   ActivityIcon → Activity      (old glyph was a clock; Activity reads truer to the name)
 *   CubeIcon     → Box
 *   RegistryIcon → Boxes         (a registry is a collection of images)
 *   ChartIcon    → BarChart3
 *   SyncIcon     → RefreshCw      (deduped — was identical to RefreshIcon)
 *   DeployIcon   → Rocket         (was identical to UploadIcon; Rocket reads as "deploy")
 *   CollapseIcon → ChevronsLeft ; ExpandIcon → ChevronsRight
 *   SignalIcon   → Wifi           (old glyph was wifi arcs)
 *   WarningIcon  → TriangleAlert ; ErrorIcon → CircleAlert ; SuccessIcon → CircleCheck
 *
 * lucide components accept `className` (and all SVG props), so the legacy
 * `{ className }` call sites keep working.
 */
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export {
  Home as HomeIcon,
  Server as ServerIcon,
  Box as CubeIcon,
  Key as KeyIcon,
  LogOut as LogoutIcon,
  Activity as ActivityIcon,
  File as FileIcon,
  Puzzle as PuzzleIcon,
  Info as InfoIcon,
  Boxes as RegistryIcon,
  Users as UsersIcon,
  Database as DatabaseIcon,
  BarChart3 as ChartIcon,
  Settings as SettingsIcon,
  Lock as LockIcon,
  Pencil as PencilIcon,
  Eye as EyeIcon,
  Trash2 as TrashIcon,
  X as XIcon,
  Check as CheckIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshIcon,
  Upload as UploadIcon,
  Download as DownloadIcon,
  TriangleAlert as WarningIcon,
  CircleAlert as ErrorIcon,
  CircleCheck as SuccessIcon,
  RefreshCw as SyncIcon,
  Link as LinkIcon,
  Rocket as DeployIcon,
  User as UserIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Bell as BellIcon,
  ExternalLink as ExternalLinkIcon,
  ChevronsLeft as CollapseIcon,
  ChevronsRight as ExpandIcon,
  ChevronLeft as ChevronLeftIcon,
  HeartPulse as HeartPulseIcon,
  Network as NetworkIcon,
  Wifi as SignalIcon,
  Tag as TagIcon,
  Cog as CogIcon,
} from 'lucide-react';

/**
 * Spinner with the spin animation baked in — the one icon that isn't a plain
 * lucide re-export, since call sites relied on `<SpinnerIcon />` animating itself.
 */
export function SpinnerIcon({ className }: { className?: string }) {
  return <Loader2 className={cn('animate-spin', className)} />;
}
