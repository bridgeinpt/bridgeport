import { useState } from 'react';
import {
  runConfigScan,
  previewConfigScan,
  applyConfigScan,
  type ConfigScanSuggestion,
  type ConfigScanPreviewDiff,
} from '../lib/api';
import { Modal } from './Modal';
import {
  RefreshIcon,
  SpinnerIcon,
  CheckIcon,
  WarningIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from './Icons';

interface ScanSuggestionsPanelProps {
  environmentId: string;
  onApplied: () => void;
}

export function ScanSuggestionsPanel({ environmentId, onApplied }: ScanSuggestionsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [suggestions, setSuggestions] = useState<ConfigScanSuggestion[]>([]);
  const [scannedFileCount, setScannedFileCount] = useState(0);
  const [skippedBinaryCount, setSkippedBinaryCount] = useState(0);
  const [lastScanAt, setLastScanAt] = useState<Date | null>(null);
  const [hasScanRun, setHasScanRun] = useState(false);

  // Review modal state
  const [reviewSuggestion, setReviewSuggestion] = useState<ConfigScanSuggestion | null>(null);
  const [reviewStep, setReviewStep] = useState<1 | 2 | 3>(1);
  const [editedKey, setEditedKey] = useState('');
  const [editedType, setEditedType] = useState<'secret' | 'var'>('var');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  // We need the actual plaintext value for apply - user enters it in the review modal
  const [plaintextValue, setPlaintextValue] = useState('');
  const [diffs, setDiffs] = useState<ConfigScanPreviewDiff[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<Array<{
    fileId: string; fileName: string; success: boolean; replacements: number; error?: string;
  }>>([]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const result = await runConfigScan(environmentId);
      setSuggestions(result.suggestions);
      setScannedFileCount(result.scannedFileCount);
      setSkippedBinaryCount(result.skippedBinaryCount);
      setLastScanAt(new Date());
      setHasScanRun(true);
      setExpanded(true);
    } finally {
      setScanning(false);
    }
  };

  const openReview = (suggestion: ConfigScanSuggestion) => {
    setReviewSuggestion(suggestion);
    setEditedKey(suggestion.proposedKey);
    setEditedType(suggestion.proposedType);
    setSelectedFileIds(suggestion.affectedFiles.map((f) => f.id));
    setPlaintextValue('');
    setDiffs([]);
    setApplyResults([]);
    setReviewStep(1);
  };

  const closeReview = () => {
    setReviewSuggestion(null);
    setReviewStep(1);
  };

  const handlePreview = async () => {
    if (!reviewSuggestion || !plaintextValue) return;
    setPreviewLoading(true);
    try {
      const result = await previewConfigScan(environmentId, {
        value: plaintextValue,
        key: editedKey,
        type: editedType,
        fileIds: selectedFileIds,
        existingSecretId: reviewSuggestion.existingSecretId,
      });
      setDiffs(result.diffs);
      setReviewStep(2);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (!reviewSuggestion || !plaintextValue) return;
    setApplying(true);
    try {
      const result = await applyConfigScan(environmentId, {
        value: plaintextValue,
        key: editedKey,
        type: editedType,
        fileIds: selectedFileIds,
        existingSecretId: reviewSuggestion.existingSecretId,
      });
      setApplyResults(result.results);
      setReviewStep(3);
      // Remove this suggestion from the list
      setSuggestions((prev) => prev.filter((s) => s !== reviewSuggestion));
      onApplied();
    } finally {
      setApplying(false);
    }
  };

  const dismissSuggestion = (suggestion: ConfigScanSuggestion) => {
    setSuggestions((prev) => prev.filter((s) => s !== suggestion));
  };

  const toggleFileId = (fileId: string) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  return (
    <>
      <div className="panel mb-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"
          >
            {expanded ? (
              <ChevronDownIcon className="w-4 h-4" />
            ) : (
              <ChevronRightIcon className="w-4 h-4" />
            )}
            <span className="font-medium">Config Scanner</span>
            {hasScanRun && suggestions.length > 0 && (
              <span className="px-1.5 py-0.5 text-xs rounded-full bg-primary-500/20 text-primary-400">
                {suggestions.length}
              </span>
            )}
          </button>
          <div className="flex items-center gap-3">
            {lastScanAt && (
              <span className="text-xs text-slate-500">
                Scanned {scannedFileCount} files
                {skippedBinaryCount > 0 && ` (${skippedBinaryCount} binary skipped)`}
              </span>
            )}
            <button
              onClick={handleScan}
              disabled={scanning}
              className="btn btn-ghost text-sm flex items-center gap-1.5"
            >
              {scanning ? (
                <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshIcon className="w-3.5 h-3.5" />
              )}
              {scanning ? 'Scanning...' : 'Run Scan'}
            </button>
          </div>
        </div>

        {expanded && (
          <div className="mt-3">
            {!hasScanRun ? (
              <p className="text-sm text-slate-500">
                Click "Run Scan" to detect hardcoded values that could be promoted to secrets or variables.
              </p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm text-slate-500">No suggestions found. Config files look clean.</p>
            ) : (
              <div className="space-y-1">
                {suggestions.map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-slate-800/50">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-1.5 py-0.5 text-[10px] uppercase font-medium rounded ${
                          s.proposedType === 'secret'
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-blue-500/20 text-blue-400'
                        }`}
                      >
                        {s.proposedType}
                      </span>
                      <span className="font-mono text-sm text-white">{s.proposedKey}</span>
                      <span className="text-xs text-slate-500">
                        {s.existingSecretKey
                          ? `Replace with existing ${s.existingSecretKey}`
                          : `${s.occurrenceCount}× in ${s.affectedFiles.length} file${s.affectedFiles.length > 1 ? 's' : ''}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openReview(s)}
                        className="btn btn-ghost text-xs"
                      >
                        Review
                      </button>
                      <button
                        onClick={() => dismissSuggestion(s)}
                        className="text-slate-500 hover:text-slate-300 text-xs px-1"
                        title="Dismiss"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Review Modal */}
      <Modal
        isOpen={!!reviewSuggestion}
        onClose={closeReview}
        title={
          reviewStep === 1
            ? 'Confirm Details'
            : reviewStep === 2
            ? 'Preview Changes'
            : 'Applied'
        }
        size="2xl"
      >
        {reviewSuggestion && (
          <div className="space-y-4">
            {/* Step 1: Confirm details */}
            {reviewStep === 1 && (
              <>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Key Name</label>
                  <input
                    type="text"
                    value={editedKey}
                    onChange={(e) => setEditedKey(e.target.value.toUpperCase())}
                    pattern="^[A-Z][A-Z0-9_]*$"
                    className="input font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Type</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditedType('secret')}
                      className={`px-3 py-1.5 rounded text-sm ${
                        editedType === 'secret'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                          : 'bg-slate-800 text-slate-400 border border-slate-600'
                      }`}
                    >
                      Secret (encrypted)
                    </button>
                    <button
                      onClick={() => setEditedType('var')}
                      className={`px-3 py-1.5 rounded text-sm ${
                        editedType === 'var'
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                          : 'bg-slate-800 text-slate-400 border border-slate-600'
                      }`}
                    >
                      Var (plaintext)
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">
                    Masked Value: <span className="font-mono text-slate-300">{reviewSuggestion.value}</span>
                  </label>
                </div>
                {!reviewSuggestion.existingSecretId && (
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">
                      Enter the full plaintext value to substitute
                    </label>
                    <textarea
                      value={plaintextValue}
                      onChange={(e) => setPlaintextValue(e.target.value)}
                      placeholder="Paste the actual value here..."
                      rows={3}
                      className="input font-mono text-sm"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Affected Files</label>
                  <div className="space-y-1">
                    {reviewSuggestion.affectedFiles.map((f) => (
                      <label key={f.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedFileIds.includes(f.id)}
                          onChange={() => toggleFileId(f.id)}
                          className="w-4 h-4 rounded border-slate-600 bg-slate-800"
                        />
                        <span className="text-white">{f.name}</span>
                        <span className="text-slate-500">({f.occurrences} occurrence{f.occurrences > 1 ? 's' : ''})</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={closeReview} className="btn btn-ghost">Cancel</button>
                  <button
                    onClick={handlePreview}
                    disabled={previewLoading || (!plaintextValue && !reviewSuggestion.existingSecretId) || selectedFileIds.length === 0}
                    className="btn btn-primary"
                  >
                    {previewLoading ? 'Loading...' : 'Preview Changes'}
                  </button>
                </div>
              </>
            )}

            {/* Step 2: Preview diffs */}
            {reviewStep === 2 && (
              <>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {diffs.map((diff) => (
                    <div key={diff.fileId} className="rounded border border-slate-700 overflow-hidden">
                      <div className="bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-300">
                        {diff.fileName}
                        <span className="text-slate-500 ml-2">({diff.replacements} replacement{diff.replacements > 1 ? 's' : ''})</span>
                      </div>
                      <div className="p-3 space-y-2 text-xs font-mono">
                        <div className="bg-red-500/10 border border-red-500/20 rounded p-2 text-red-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                          {diff.before}
                        </div>
                        <div className="bg-green-500/10 border border-green-500/20 rounded p-2 text-green-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                          {diff.after}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between">
                  <button onClick={() => setReviewStep(1)} className="btn btn-ghost">Back</button>
                  <button
                    onClick={handleApply}
                    disabled={applying}
                    className="btn btn-primary"
                  >
                    {applying ? 'Applying...' : 'Apply Changes'}
                  </button>
                </div>
              </>
            )}

            {/* Step 3: Results */}
            {reviewStep === 3 && (
              <>
                <div className="space-y-2">
                  {applyResults.map((r) => (
                    <div key={r.fileId} className="flex items-center gap-2 text-sm">
                      {r.success ? (
                        <CheckIcon className="w-4 h-4 text-green-400" />
                      ) : (
                        <WarningIcon className="w-4 h-4 text-red-400" />
                      )}
                      <span className={r.success ? 'text-slate-300' : 'text-red-400'}>
                        {r.fileName}
                        {r.success ? ` — ${r.replacements} replacement${r.replacements > 1 ? 's' : ''}` : ` — ${r.error}`}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <button onClick={closeReview} className="btn btn-primary">Done</button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
