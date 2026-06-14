import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Boxes,
  Database,
  FileText,
  Gauge,
  HeartPulse,
  Home,
  Key,
  Network,
  Rocket,
  Server,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useAppStore } from '@/lib/store';
import {
  listServers,
  listServices,
  listDatabases,
  type Server as ServerType,
  type ServiceWithServerName,
  type Database as DatabaseType,
} from '@/lib/api';

interface PageEntry {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PAGES: PageEntry[] = [
  { label: 'Dashboard', href: '/', icon: Home },
  { label: 'Servers', href: '/servers', icon: Server },
  { label: 'Services', href: '/services', icon: Box },
  { label: 'Databases', href: '/databases', icon: Database },
  { label: 'Monitoring', href: '/monitoring', icon: Gauge },
  { label: 'Health Checks', href: '/monitoring/health', icon: HeartPulse },
  { label: 'Agents & SSH', href: '/monitoring/agents', icon: Network },
  { label: 'Container Images', href: '/container-images', icon: Boxes },
  { label: 'Deployment Plans', href: '/deployment-plans', icon: Rocket },
  { label: 'Secrets & Vars', href: '/secrets', icon: Key },
  { label: 'Config Files', href: '/config-files', icon: FileText },
];

/**
 * ⌘K / Ctrl-K command palette (#246): quick-jump to pages and search the
 * current environment's servers / services / databases. Mounted once per shell.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const selectedEnvironment = useAppStore((s) => s.selectedEnvironment);
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ServerType[]>([]);
  const [services, setServices] = useState<ServiceWithServerName[]>([]);
  const [databases, setDatabases] = useState<DatabaseType[]>([]);

  // Global ⌘K / Ctrl-K toggle.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Lazy-load entities for the current environment when first opened.
  useEffect(() => {
    if (!open || !selectedEnvironment) return;
    const envId = selectedEnvironment.id;
    let cancelled = false;
    Promise.allSettled([
      listServers(envId, { limit: 100 }),
      listServices(envId, { limit: 100 }),
      listDatabases(envId, { limit: 100 }),
    ]).then((results) => {
      if (cancelled) return;
      if (results[0].status === 'fulfilled') setServers(results[0].value.servers as ServerType[]);
      if (results[1].status === 'fulfilled') setServices(results[1].value.services);
      if (results[2].status === 'fulfilled') setDatabases(results[2].value.databases);
    });
    return () => {
      cancelled = true;
    };
  }, [open, selectedEnvironment]);

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a page or search resources">
      <CommandInput placeholder="Jump to a page or search servers, services, databases…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {PAGES.map((page) => (
            <CommandItem key={page.href} value={`page ${page.label}`} onSelect={() => go(page.href)}>
              <page.icon className="size-4" />
              {page.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {servers.length > 0 && (
          <CommandGroup heading="Servers">
            {servers.map((s) => (
              <CommandItem key={s.id} value={`server ${s.name}`} onSelect={() => go(`/servers/${s.id}`)}>
                <Server className="size-4" />
                {s.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {services.length > 0 && (
          <CommandGroup heading="Services">
            {services.map((s) => (
              <CommandItem key={s.id} value={`service ${s.name}`} onSelect={() => go(`/services/${s.id}`)}>
                <Box className="size-4" />
                {s.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {databases.length > 0 && (
          <CommandGroup heading="Databases">
            {databases.map((d) => (
              <CommandItem key={d.id} value={`database ${d.name}`} onSelect={() => go(`/databases/${d.id}`)}>
                <Database className="size-4" />
                {d.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

export default CommandPalette;
