import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface DataPaginationProps {
  /** Current page (0-based), matching `usePagination`/`usePaginatedFetch`. */
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

/** Windowed page list with leading/trailing pages + ellipses (0-based). */
function getPageNumbers(currentPage: number, totalPages: number): (number | 'ellipsis')[] {
  const pages: (number | 'ellipsis')[] = [];
  const maxVisiblePages = 5;

  if (totalPages <= maxVisiblePages) {
    for (let i = 0; i < totalPages; i++) pages.push(i);
    return pages;
  }

  pages.push(0);
  const start = Math.max(1, currentPage - 1);
  const end = Math.min(totalPages - 2, currentPage + 1);
  if (start > 1) pages.push('ellipsis');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < totalPages - 2) pages.push('ellipsis');
  if (totalPages > 1) pages.push(totalPages - 1);
  return pages;
}

/**
 * Presentational pager on shadcn primitives + Deep Slate tokens (#244).
 * Preserves the legacy `Pagination` prop contract (0-based, paired with
 * `usePagination`/`usePaginatedFetch`) so pages migrate by swapping the import.
 */
export function DataPagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50],
  className,
}: DataPaginationProps) {
  if (totalPages <= 1 && !onPageSizeChange) return null;

  const startItem = totalItems > 0 ? currentPage * pageSize + 1 : 0;
  const endItem = Math.min((currentPage + 1) * pageSize, totalItems);

  return (
    <div className={cn('flex items-center justify-between border-t pt-4', className)}>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">
          {totalItems > 0 ? `Showing ${startItem}-${endItem} of ${totalItems}` : 'No items'}
        </span>

        {onPageSizeChange && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">per page:</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
            >
              <SelectTrigger size="sm" className="w-[72px]" aria-label="Items per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onPageChange(currentPage - 1)}
                disabled={currentPage === 0}
                aria-label="Previous page"
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
            </PaginationItem>

            {getPageNumbers(currentPage, totalPages).map((page, index) =>
              page === 'ellipsis' ? (
                <PaginationItem key={`ellipsis-${index}`}>
                  <span className="px-2 text-muted-foreground" aria-hidden="true">
                    …
                  </span>
                </PaginationItem>
              ) : (
                <PaginationItem key={page}>
                  <Button
                    variant={page === currentPage ? 'secondary' : 'ghost'}
                    size="icon"
                    onClick={() => onPageChange(page)}
                    aria-label={`Page ${page + 1}`}
                    aria-current={page === currentPage ? 'page' : undefined}
                  >
                    {page + 1}
                  </Button>
                </PaginationItem>
              )
            )}

            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onPageChange(currentPage + 1)}
                disabled={currentPage >= totalPages - 1}
                aria-label="Next page"
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}

export default DataPagination;
