import { Link, useLocation } from 'react-router-dom';
import { ChevronRightIcon } from './Icons';

// Route name mappings
const routeNames: Record<string, string> = {
  '': 'Dashboard',
  'services': 'Services',
  'servers': 'Servers',
  'secrets': 'Secrets',
  'config-files': 'Config Files',
  'registries': 'Registries',
  'databases': 'Databases',
  'activity': 'Audit Logs',
  'users': 'Users',
  'settings': 'Environment Config',
  'about': 'About',
  'container-images': 'Container Images',
  'deployment-plans': 'Deployment Plans',
  'admin': 'Admin',
  'notifications': 'Notifications Config',
};

interface Crumb {
  name: string;
  href: string;
  isLast: boolean;
}

export default function Breadcrumbs() {
  const location = useLocation();
  const pathSegments = location.pathname.split('/').filter(Boolean);

  // Build breadcrumbs from path segments
  const crumbs: Crumb[] = [];
  let currentPath = '';

  pathSegments.forEach((segment, index) => {
    currentPath += `/${segment}`;
    const isLast = index === pathSegments.length - 1;

    // Skip ID segments (UUIDs or numeric IDs)
    const isId = /^[0-9a-f-]{36}$|^\d+$/.test(segment);

    if (isId) {
      // For detail pages, show generic "Details" or infer from previous segment
      crumbs.push({
        name: 'Details',
        href: currentPath,
        isLast,
      });
    } else {
      crumbs.push({
        name: routeNames[segment] || segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' '),
        href: currentPath,
        isLast,
      });
    }
  });

  // If on root, don't show breadcrumbs
  if (crumbs.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center text-sm text-slate-400">
      <Link to="/" className="hover:text-white transition-colors">
        Dashboard
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center">
          <ChevronRightIcon className="w-3 h-3 mx-2 text-slate-600" />
          {crumb.isLast ? (
            <span className="text-white">{crumb.name}</span>
          ) : (
            <Link to={crumb.href} className="hover:text-white transition-colors">
              {crumb.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
