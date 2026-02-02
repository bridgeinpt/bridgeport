import { useState, useMemo } from 'react';

interface UsePaginationOptions<T> {
  data: T[];
  defaultPageSize?: number;
}

interface UsePaginationResult<T> {
  /** Current page (0-indexed) */
  currentPage: number;
  /** Total number of pages */
  totalPages: number;
  /** Total number of items */
  totalItems: number;
  /** Current page size */
  pageSize: number;
  /** Items to display on current page */
  paginatedData: T[];
  /** Go to a specific page */
  setPage: (page: number) => void;
  /** Change page size (resets to page 0) */
  setPageSize: (size: number) => void;
  /** Go to next page */
  nextPage: () => void;
  /** Go to previous page */
  prevPage: () => void;
  /** Reset to first page */
  resetPage: () => void;
}

/**
 * Hook for client-side pagination of arrays.
 *
 * @example
 * const { paginatedData, currentPage, totalPages, setPage, pageSize, setPageSize } = usePagination({
 *   data: items,
 *   defaultPageSize: 25,
 * });
 */
export function usePagination<T>({
  data,
  defaultPageSize = 25,
}: UsePaginationOptions<T>): UsePaginationResult<T> {
  const [currentPage, setCurrentPage] = useState(0);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);

  const totalItems = data.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  // Ensure current page is valid when data changes
  const validPage = Math.min(currentPage, Math.max(0, totalPages - 1));
  if (validPage !== currentPage) {
    setCurrentPage(validPage);
  }

  const paginatedData = useMemo(() => {
    const start = validPage * pageSize;
    const end = start + pageSize;
    return data.slice(start, end);
  }, [data, validPage, pageSize]);

  const setPage = (page: number) => {
    const newPage = Math.max(0, Math.min(page, totalPages - 1));
    setCurrentPage(newPage);
  };

  const setPageSize = (size: number) => {
    setPageSizeState(size);
    setCurrentPage(0); // Reset to first page when changing page size
  };

  const nextPage = () => {
    if (currentPage < totalPages - 1) {
      setCurrentPage(currentPage + 1);
    }
  };

  const prevPage = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
    }
  };

  const resetPage = () => {
    setCurrentPage(0);
  };

  return {
    currentPage: validPage,
    totalPages,
    totalItems,
    pageSize,
    paginatedData,
    setPage,
    setPageSize,
    nextPage,
    prevPage,
    resetPage,
  };
}

export default usePagination;
