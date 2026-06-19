import { Link, useLocation } from 'react-router-dom';
import { Logo } from './Logo';
import {
  Activity,
  ArrowLeft,
  Bell,
  Cloud,
  Cog,
  Database,
  Info,
  MonitorCog,
  Plug,
  Terminal,
  Users,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navigationItems: NavItem[] = [
  { name: 'About', href: '/admin/about', icon: Info },
  { name: 'System', href: '/admin/system', icon: Cog },
  { name: 'Service Types', href: '/admin/service-types', icon: Terminal },
  { name: 'Database Types', href: '/admin/database-types', icon: Database },
  { name: 'Storage', href: '/admin/storage', icon: Cloud },
  { name: 'Users', href: '/admin/users', icon: Users },
  { name: 'Integrations', href: '/admin/integrations', icon: Plug },
  { name: 'MCP Server', href: '/admin/mcp', icon: MonitorCog },
  { name: 'Audit', href: '/admin/audit', icon: Activity },
  { name: 'Notifications', href: '/admin/notifications', icon: Bell },
];

// Active item: burgundy left stripe via the sidebar-primary token.
const activeItemClass =
  'relative data-[active=true]:before:absolute data-[active=true]:before:inset-y-1 data-[active=true]:before:left-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-r data-[active=true]:before:bg-sidebar-primary';

export default function AdminSidebar() {
  const location = useLocation();

  return (
    <Sidebar>
      <SidebarHeader>
        <Link
          to="/"
          title="Back to App"
          aria-label="Back to App"
          className="flex h-8 items-center justify-center"
        >
          <Logo variant="lockup" className="text-lg" />
        </Link>
        <Button asChild variant="ghost" className="justify-start gap-2">
          <Link to="/">
            <ArrowLeft className="size-4" />
            Back to App
          </Link>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-brand">Admin Settings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => {
                const isActive = location.pathname === item.href;
                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.name} className={activeItemClass}>
                      <Link to={item.href}>
                        <item.icon className="size-4" />
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
