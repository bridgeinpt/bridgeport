import { ChevronDown, LogOut, Terminal, User } from 'lucide-react';
import { useAuthStore } from '../lib/store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ThemeMenuItems } from '@/components/ui/theme-switcher';
import NotificationBell from './NotificationBell';
import Breadcrumbs from './Breadcrumbs';

interface AdminTopBarProps {
  onOpenAccount: () => void;
  onOpenCLI: () => void;
}

export default function AdminTopBar({ onOpenAccount, onOpenCLI }: AdminTopBarProps) {
  const { user, logout } = useAuthStore();

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-1 items-center">
        <Breadcrumbs />
      </div>

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onOpenCLI} title="CLI Tool" aria-label="CLI Tool">
              <Terminal className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>CLI Tool</TooltipContent>
        </Tooltip>

        <NotificationBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2" aria-label="User menu">
              <User className="size-4" />
              <span className="hidden max-w-[140px] truncate sm:inline">{user?.name || user?.email}</span>
              {user?.role && (
                <Badge variant="neutral" className="hidden uppercase sm:inline-flex">
                  {user.role}
                </Badge>
              )}
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="truncate">{user?.name || user?.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenAccount}>
              <User className="size-4" />
              My Account
            </DropdownMenuItem>
            <ThemeMenuItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                logout();
                window.location.href = '/login';
              }}
            >
              <LogOut className="size-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TooltipProvider>
  );
}
