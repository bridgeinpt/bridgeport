import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useAppStore } from '../lib/store';

// Route name mappings
const routeNames: Record<string, string> = {
  '': 'Dashboard',
  services: 'Services',
  servers: 'Servers',
  secrets: 'Secrets',
  'config-files': 'Config Files',
  fragments: 'Fragments',
  registries: 'Registries',
  databases: 'Databases',
  settings: 'Settings',
  'container-images': 'Container Images',
  'deployment-plans': 'Deployment Plans',
  notifications: 'Notifications',
  monitoring: 'Monitoring',
  health: 'Health Checks',
  agents: 'Agents & SSH',
  // Admin routes
  admin: 'Admin',
  system: 'System',
  'service-types': 'Service Types',
  'database-types': 'Database Types',
  storage: 'Storage',
  users: 'Users',
  audit: 'Audit',
  about: 'About',
  integrations: 'Integrations',
  mcp: 'MCP Server',
};

interface Crumb {
  name: string;
  href: string;
  isLast: boolean;
}

/**
 * Breadcrumb trail on shadcn primitives (#246). Owns the page title (no `<h1>`
 * on pages). Keeps the route-name map + session `breadcrumbNames` ID resolution.
 */
export default function Breadcrumbs() {
  const location = useLocation();
  const breadcrumbNames = useAppStore((s) => s.breadcrumbNames);
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const isAdminSection = pathSegments[0] === 'admin';

  const crumbs: Crumb[] = [];
  let currentPath = '';
  pathSegments.forEach((segment, index) => {
    currentPath += `/${segment}`;
    const isLast = index === pathSegments.length - 1;
    const isId = /^[0-9a-f-]{36}$|^\d+$/.test(segment);
    crumbs.push({
      name: isId
        ? breadcrumbNames[segment] || 'Details'
        : routeNames[segment] || segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' '),
      href: currentPath,
      isLast,
    });
  });

  if (crumbs.length === 0) {
    return null;
  }

  const linkClass = isAdminSection ? 'text-brand hover:text-brand/80' : undefined;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild className={linkClass}>
            <Link to="/">Dashboard</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {crumbs.map((crumb) => (
          <Fragment key={crumb.href}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {crumb.isLast ? (
                <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild className={linkClass}>
                  <Link to={crumb.href}>{crumb.name}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
