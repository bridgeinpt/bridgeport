import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Box,
  ChevronDown,
  Container,
  Database,
  FileText,
  Gauge,
  HeartPulse,
  Home,
  Boxes,
  Key,
  Network,
  Puzzle,
  Rocket,
  Server,
  Settings,
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
  useSidebar,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore, useAuthStore, isAdmin } from '../lib/store';
import { listEnvironments, type Environment } from '../lib/api';
import { cn } from '@/lib/utils';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

interface NavGroup {
  name: string;
  items: NavItem[];
}

const navigationGroups: NavGroup[] = [
  {
    name: 'Operations',
    items: [
      { name: 'Dashboard', href: '/', icon: Home },
      { name: 'Servers', href: '/servers', icon: Server },
      { name: 'Services', href: '/services', icon: Box },
      { name: 'Databases', href: '/databases', icon: Database },
    ],
  },
  {
    name: 'Monitoring',
    items: [
      { name: 'Overview', href: '/monitoring', icon: Gauge },
      { name: 'Servers', href: '/monitoring/servers', icon: Server },
      { name: 'Services', href: '/monitoring/services', icon: Box },
      { name: 'Databases', href: '/monitoring/databases', icon: Database },
      { name: 'Health Checks', href: '/monitoring/health', icon: HeartPulse },
      { name: 'Agents & SSH', href: '/monitoring/agents', icon: Network },
    ],
  },
  {
    name: 'Orchestration',
    items: [
      { name: 'Container Images', href: '/container-images', icon: Boxes },
      { name: 'Deployment Plans', href: '/deployment-plans', icon: Rocket },
      { name: 'Registries', href: '/registries', icon: Container },
    ],
  },
  {
    name: 'Configuration',
    items: [
      { name: 'Environment', href: '/settings', icon: Settings, adminOnly: true },
      { name: 'Secrets & Vars', href: '/secrets', icon: Key },
      { name: 'Config Files', href: '/config-files', icon: FileText },
      { name: 'Fragments', href: '/fragments', icon: Puzzle },
    ],
  },
];

// Active item: burgundy left stripe via the sidebar-primary token.
const activeItemClass =
  'relative data-[active=true]:before:absolute data-[active=true]:before:inset-y-1 data-[active=true]:before:left-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-r data-[active=true]:before:bg-sidebar-primary';

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { selectedEnvironment, setSelectedEnvironment, clearSelectedEnvironment, collapsedGroups, toggleGroup } =
    useAppStore();
  const { state } = useSidebar();
  const [environments, setEnvironments] = useState<Environment[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Retry on cold start so an env always gets selected even if the backend
    // is still booting (otherwise env-scoped pages sit on a skeleton forever).
    const loadEnvironments = (attempt = 0) => {
      listEnvironments()
        .then(({ environments }) => {
          if (cancelled) return;
          setEnvironments(environments);
          if (selectedEnvironment) {
            const stillExists = environments.some((env) => env.id === selectedEnvironment.id);
            if (!stillExists) {
              if (environments.length > 0) setSelectedEnvironment(environments[0]);
              else clearSelectedEnvironment();
            }
          } else if (environments.length > 0) {
            setSelectedEnvironment(environments[0]);
          }
        })
        .catch(() => {
          if (cancelled || attempt >= 5) return;
          setTimeout(() => loadEnvironments(attempt + 1), 500 * 2 ** attempt);
        });
    };
    loadEnvironments();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEnvironmentChange = (id: string) => {
    const env = environments.find((e) => e.id === id);
    setSelectedEnvironment(env || null);
    // Leave detail pages — the object won't exist in the new environment.
    const segments = location.pathname.split('/').filter(Boolean);
    const hasId = segments.some((s) => /^[0-9a-f-]{36}$|^\d+$/.test(s));
    if (hasId) {
      const parentSegments: string[] = [];
      for (const s of segments) {
        if (/^[0-9a-f-]{36}$|^\d+$/.test(s)) break;
        parentSegments.push(s);
      }
      navigate(parentSegments.length > 0 ? '/' + parentSegments.join('/') : '/');
    }
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link to="/" className="flex h-8 items-center justify-center gap-2 px-1" aria-label="BRIDGEPORT home">
          <img src="/favicon.png" alt="" className="size-7 shrink-0" />
          <img src="/logo.png" alt="BRIDGEPORT" className="h-7 group-data-[collapsible=icon]:hidden" />
        </Link>
        <div className="px-1 group-data-[collapsible=icon]:hidden">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Environment</label>
          <Select value={selectedEnvironment?.id || ''} onValueChange={onEnvironmentChange}>
            <SelectTrigger size="sm" className="mt-1 w-full" aria-label="Select environment">
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              {environments.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  {env.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {navigationGroups.map((group) => {
          const visibleItems = group.items.filter((item) => !item.adminOnly || isAdmin(user));
          if (visibleItems.length === 0) return null;

          const groupCollapsed = collapsedGroups.includes(group.name);
          const groupOpen = state === 'collapsed' ? true : !groupCollapsed;

          return (
            <Collapsible
              key={group.name}
              open={groupOpen}
              onOpenChange={() => toggleGroup(group.name)}
              className="group/collapsible"
            >
              <SidebarGroup>
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger aria-label={`Toggle ${group.name} navigation`}>
                    {group.name}
                    <ChevronDown className="ml-auto size-3 transition-transform group-data-[state=closed]/collapsible:-rotate-90" />
                  </CollapsibleTrigger>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {visibleItems.map((item) => {
                        const isActive = location.pathname === item.href;
                        return (
                          <SidebarMenuItem key={`${group.name}-${item.name}`}>
                            <SidebarMenuButton
                              asChild
                              isActive={isActive}
                              tooltip={item.name}
                              className={cn(activeItemClass)}
                            >
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
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          );
        })}
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}

export default AppSidebar;
