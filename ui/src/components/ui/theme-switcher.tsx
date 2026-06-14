import { Monitor, Moon, Sun } from 'lucide-react';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme, type Theme } from '@/components/theme-provider';

const TRIGGER_ICON: Record<Theme, React.ComponentType<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * Theme submenu (#255) for the user-menu DropdownMenu — System / Light / Dark.
 * The trigger icon reflects the current selection; the radio group reflects and
 * updates it via the ThemeProvider.
 */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  const TriggerIcon = TRIGGER_ICON[theme];

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <TriggerIcon className="size-4" />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" />
            System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" />
            Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export default ThemeMenuItems;
