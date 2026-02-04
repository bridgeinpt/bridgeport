import { Modal } from './Modal.js';
import { CheckIcon, WarningIcon, SpinnerIcon } from './Icons.js';

export interface OperationResult {
  id: string;
  label: string;
  sublabel?: string;
  detail?: string;
  success: boolean;
  error?: string;
}

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
  closeText = 'Done',
}: OperationResultsModalProps): JSX.Element {
  const isLoading = results === null;
  const successCount = results?.filter((r) => r.success).length ?? 0;
  const totalCount = results?.length ?? 0;
  const allSuccess = results?.every((r) => r.success) ?? false;
  const someSuccess = successCount > 0;

  function getSummaryStyle(): string {
    if (allSuccess) {
      return 'bg-green-500/10 border border-green-500/30';
    }
    if (someSuccess) {
      return 'bg-yellow-500/10 border border-yellow-500/30';
    }
    return 'bg-red-500/10 border border-red-500/30';
  }

  function getSummaryTextColor(): string {
    if (allSuccess) return 'text-green-400';
    if (someSuccess) return 'text-yellow-400';
    return 'text-red-400';
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-8">
          <SpinnerIcon className="h-8 w-8 text-primary-500 mb-4" />
          <p className="text-slate-400">
            {loadingMessage}
            {loadingCount !== undefined && ` (${loadingCount} items)`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary */}
          <div className={`p-3 rounded-lg ${getSummaryStyle()}`}>
            <div className="flex items-center gap-2">
              {allSuccess ? (
                <CheckIcon className="w-5 h-5 text-green-400" />
              ) : (
                <WarningIcon className="w-5 h-5 text-yellow-400" />
              )}
              <span className={getSummaryTextColor()}>
                {successCount} of {totalCount} completed successfully
              </span>
            </div>
          </div>

          {/* Results List */}
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {results?.map((result) => (
              <div
                key={result.id}
                className={`p-2 rounded-lg text-sm ${
                  result.success ? 'bg-slate-800/50' : 'bg-red-500/10'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-white">{result.label}</span>
                    {result.sublabel && (
                      <>
                        <span className="text-slate-500 mx-2">on</span>
                        <span className="text-slate-400">{result.sublabel}</span>
                      </>
                    )}
                    {result.detail && (
                      <>
                        <span className="text-slate-500 mx-2">-</span>
                        <span className="font-mono text-primary-400">{result.detail}</span>
                      </>
                    )}
                  </div>
                  {result.success ? (
                    <CheckIcon className="w-4 h-4 text-green-400" />
                  ) : (
                    <WarningIcon className="w-4 h-4 text-red-400" />
                  )}
                </div>
                {result.error && (
                  <p className="text-red-400 text-xs mt-1">{result.error}</p>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <button onClick={onClose} className="btn btn-primary">
              {closeText}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default OperationResultsModal;
