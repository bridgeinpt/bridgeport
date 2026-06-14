import { Fragment, useEffect, useState } from 'react';
import { useAppStore } from '../../lib/store';
import { getAuditLogs, listEnvironments, type AuditLog, type Environment } from '../../lib/api';
import { usePaginatedFetch } from '../../hooks/usePaginatedFetch.js';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown } from 'lucide-react';
import { safeJsonParse } from '../../lib/helpers';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import type { StatusVariant } from '@/lib/status';
import { DataPagination } from '@/components/ui/data-pagination';
import { TableSkeleton } from '@/components/ui/table-skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const RESOURCE_TYPES = [
  { value: 'all', label: 'All Types' },
  { value: 'service', label: 'Service' },
  { value: 'server', label: 'Server' },
  { value: 'secret', label: 'Secret' },
  { value: 'environment', label: 'Environment' },
  { value: 'env_template', label: 'Env Template' },
];

// Maps each audit action to a Badge variant, preserving the legacy color intent
// (create=green/success, update/discover=blue/info, delete=red/destructive,
// the remaining accent colors collapse to the closest semantic variant).
const ACTION_VARIANTS: Record<string, StatusVariant> = {
  create: 'success',
  update: 'info',
  delete: 'destructive',
  deploy: 'info',
  restart: 'warning',
  health_check: 'info',
  access: 'warning',
  webhook_deploy: 'info',
  discover: 'info',
  import: 'success',
};

export default function Audit() {
  const { activityResourceTypeFilter, setActivityResourceTypeFilter } = useAppStore();
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  // Filters for admin view
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>('');

  const { items: logs, total, loading, currentPage, pageSize, totalPages, setCurrentPage } =
    usePaginatedFetch<AuditLog>({
      fetcher: ({ limit, offset }) =>
        getAuditLogs({
          environmentId: selectedEnvironmentId || undefined,
          resourceType: activityResourceTypeFilter || undefined,
          limit,
          offset,
        }).then(r => ({ items: r.logs, total: r.total })),
      deps: [selectedEnvironmentId, activityResourceTypeFilter],
      defaultPageSize: 20,
    });

  // Load environments on mount
  useEffect(() => {
    listEnvironments().then((envsRes) => {
      setEnvironments(envsRes.environments);
    });
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <TableSkeleton rows={5} columns={6} />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Filters */}
      <div className="mb-6 flex items-center gap-4">
        <Select
          value={selectedEnvironmentId || 'all'}
          onValueChange={(value) => setSelectedEnvironmentId(value === 'all' ? '' : value)}
        >
          <SelectTrigger className="w-[200px]" aria-label="Filter by environment">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Environments</SelectItem>
            {environments.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                {env.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={activityResourceTypeFilter || 'all'}
          onValueChange={(value) => setActivityResourceTypeFilter(value === 'all' ? '' : value)}
        >
          <SelectTrigger className="w-[180px]" aria-label="Filter by resource type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_TYPES.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                {type.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No activity logs found
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <Fragment key={log.id}>
                  <TableRow>
                    <TableCell className="text-sm">
                      <span
                        title={new Date(log.createdAt).toLocaleString()}
                        className="text-muted-foreground"
                      >
                        {formatDistanceToNow(new Date(log.createdAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-foreground">{log.user?.email || 'System'}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {log.environment?.name || '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        kind="severity"
                        value={log.action}
                        variant={ACTION_VARIANTS[log.action] ?? 'neutral'}
                        label={log.action.replace('_', ' ')}
                      />
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="text-xs uppercase text-muted-foreground">
                          {log.resourceType.replace('_', ' ')}
                        </span>
                        {log.resourceName && (
                          <span className="ml-2 font-medium text-foreground">
                            {log.resourceName}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {log.success ? (
                        <StatusBadge kind="deployment" value="success" label="Success" />
                      ) : (
                        <StatusBadge kind="deployment" value="failed" label="Failed" />
                      )}
                    </TableCell>
                    <TableCell>
                      {(log.details || log.error) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setExpandedLog(expandedLog === log.id ? null : log.id)
                          }
                          aria-label={expandedLog === log.id ? 'Collapse details' : 'Expand details'}
                          aria-expanded={expandedLog === log.id}
                        >
                          <ChevronDown
                            className={`size-5 transition-transform ${
                              expandedLog === log.id ? 'rotate-180' : ''
                            }`}
                          />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {expandedLog === log.id && (log.details || log.error) && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/50 px-4 py-4">
                        {log.error && (
                          <div className="mb-2">
                            <span className="font-medium text-destructive">Error: </span>
                            <span className="text-foreground">{log.error}</span>
                          </div>
                        )}
                        {log.details && (
                          <pre className="overflow-x-auto text-xs text-muted-foreground">
                            {JSON.stringify(safeJsonParse(log.details, {}), null, 2)}
                          </pre>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 pb-4">
            <DataPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={total}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
