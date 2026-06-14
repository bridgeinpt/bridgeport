import { ReactElement } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckIcon, WarningIcon, SpinnerIcon } from './Icons.js';

export interface OperationResult {
  id: string;
  label: string;
  sublabel?: string;
  detail?: string;
  success: boolean;
  error?: string;
}

/**
 * Terminal status of a sync/operation envelope (issue #127). Passed through
 * from the backend's `SyncEnvelope.status`. `no_targets` is distinct from `ok`
 * and renders a yellow "nothing to do" warning instead of a green checkmark.
 */
export type OperationStatus = 'ok' | 'no_targets' | 'partial' | 'failed';

interface OperationResultsModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Message to show while loading */
  loadingMessage: string;
  /** Number of items being processed (for loading state) */
  loadingCount?: number;
  /** Results to display (null means still loading) */
  results: OperationResult[] | null;
  /**
   * Optional terminal status. When `no_targets`, the modal renders a yellow
   * warning banner ("nothing to sync") instead of computing summary from
   * results.length === 0. Without this prop we fall back to inferring status
   * from the results array (legacy behaviour).
   */
  status?: OperationStatus;
  /** Message for the warning banner when `status === 'no_targets'`. */
  noTargetsMessage?: string;
  /** Button text for closing the modal */
  closeText?: string;
}

/**
 * Reusable modal for displaying operation results (bulk deploy, sync, etc.).
 * Shows a loading spinner while processing, then displays results with success/failure status.
 */
export function OperationResultsModal({
  isOpen,
  onClose,
  title,
  loadingMessage,
  loadingCount,
  results,
  status,
  noTargetsMessage = 'Nothing to do — no targets matched this operation.',
  closeText = 'Done',
}: OperationResultsModalProps): ReactElement {
  const isLoading = results === null;
  const successCount = results?.filter((r) => r.success).length ?? 0;
  const totalCount = results?.length ?? 0;
  // Guard against `[].every(...) === true` (vacuous truth) so an empty results
  // array doesn't masquerade as "all succeeded" if a future caller forgets to
  // pass the `no_targets` status explicitly.
  const allSuccess = totalCount > 0 && (results?.every((r) => r.success) ?? false);
  const someSuccess = successCount > 0;
  // `no_targets` is a terminal warning state (issue #127): the operation
  // returned 200 OK but did nothing because there was nothing to act on.
  const isNoTargets = status === 'no_targets';

  function getSummaryStyle(): string {
    if (isNoTargets) {
      return 'bg-warning/10 border border-warning/30';
    }
    if (allSuccess) {
      return 'bg-success/10 border border-success/30';
    }
    if (someSuccess) {
      return 'bg-warning/10 border border-warning/30';
    }
    return 'bg-destructive/10 border border-destructive/30';
  }

  function getSummaryTextColor(): string {
    if (isNoTargets) return 'text-warning';
    if (allSuccess) return 'text-success';
    if (someSuccess) return 'text-warning';
    return 'text-destructive';
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-8">
            <SpinnerIcon className="h-8 w-8 text-primary mb-4" />
            <p className="text-muted-foreground">
              {loadingMessage}
              {loadingCount !== undefined && ` (${loadingCount} items)`}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className={`p-3 rounded-lg ${getSummaryStyle()}`}>
              <div className="flex items-center gap-2">
                {isNoTargets ? (
                  <WarningIcon className="w-5 h-5 text-warning" />
                ) : allSuccess ? (
                  <CheckIcon className="w-5 h-5 text-success" />
                ) : (
                  <WarningIcon className="w-5 h-5 text-warning" />
                )}
                <span className={getSummaryTextColor()}>
                  {isNoTargets
                    ? noTargetsMessage
                    : `${successCount} of ${totalCount} completed successfully`}
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {results?.map((result) => (
                <div
                  key={result.id}
                  className={`p-2 rounded-lg text-sm ${
                    result.success ? 'bg-muted/50' : 'bg-destructive/10'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-foreground">{result.label}</span>
                      {result.sublabel && (
                        <>
                          <span className="text-muted-foreground mx-2">on</span>
                          <span className="text-muted-foreground">{result.sublabel}</span>
                        </>
                      )}
                      {result.detail && (
                        <>
                          <span className="text-muted-foreground mx-2">-</span>
                          <span className="font-mono text-primary">{result.detail}</span>
                        </>
                      )}
                    </div>
                    {result.success ? (
                      <CheckIcon className="w-4 h-4 text-success" />
                    ) : (
                      <WarningIcon className="w-4 h-4 text-destructive" />
                    )}
                  </div>
                  {result.error && (
                    <p className="text-destructive text-xs mt-1">{result.error}</p>
                  )}
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button onClick={onClose}>{closeText}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default OperationResultsModal;
