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
  // Prefilled from suggestion.value for hardcoded_value; user enters it for missing_reference.
  const [plaintextValue, setPlaintextValue] = useState('');
  const [diffs, setDiffs] = useState<ConfigScanPreviewDiff[]>([]);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<Array<{
    fileId: string; fileName: string; success: boolean; replacements: number; error?: string;
  }>>([]);

  const isMissingRef = reviewSuggestion?.kind === 'missing_reference';

  const modalTitle = () => {
    if (reviewStep === 1) return isMissingRef ? 'Define Missing Variable' : 'Confirm Details';
    if (reviewStep === 2) return 'Preview Changes';
    return isMissingRef ? 'Created' : 'Applied';
  };

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
    // Missing references don't touch files; everything else preselects all affected files
    setSelectedFileIds(
      suggestion.kind === 'missing_reference' ? [] : suggestion.affectedFiles.map((f) => f.id)
    );
    setPlaintextValue(suggestion.value);
    setDiffs([]);
    setExpandedFiles({});
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
        kind: reviewSuggestion.kind,
        value: plaintextValue,
        key: editedKey,
        type: editedType,
        fileIds: selectedFileIds,
        existingSecretId: reviewSuggestion.existingSecretId,
      });
      setDiffs(result.diffs);
      // Default-expand when there are few files; collapse when many to keep the dialog manageable
      const initialExpanded: Record<string, boolean> = {};
      const expandByDefault = result.diffs.length <= 3;
      for (const d of result.diffs) initialExpanded[d.fileId] = expandByDefault;
      setExpandedFiles(initialExpanded);
      setReviewStep(2);
    } finally {
      setPreviewLoading(false);
    }
  };

  const toggleFileExpanded = (fileId: string) => {
    setExpandedFiles((prev) => ({ ...prev, [fileId]: !prev[fileId] }));
  };

  const handleApply = async () => {
    if (!reviewSuggestion || !plaintextValue) return;
    setApplying(true);
    try {
      const result = await applyConfigScan(environmentId, {
        kind: reviewSuggestion.kind,
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
                      {s.kind === 'missing_reference' ? (
                        <span className="text-xs text-amber-400 flex items-center gap-1">
                          <WarningIcon className="w-3 h-3" />
                          Referenced but not defined ({s.occurrenceCount}× in {s.affectedFiles.length} file{s.affectedFiles.length > 1 ? 's' : ''})
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">
                          {s.existingSecretKey
                            ? `Replace with existing ${s.existingSecretKey}`
                            : `${s.occurrenceCount}× in ${s.affectedFiles.length} file${s.affectedFiles.length > 1 ? 's' : ''}`}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openReview(s)}
                        className="btn btn-ghost text-xs"
                      >
                        {s.kind === 'missing_reference' ? 'Define' : 'Review'}
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
        title={modalTitle()}
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
                {!reviewSuggestion.existingSecretId && (
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">
                      {isMissingRef
                        ? `Value for ${editedType === 'secret' ? 'this secret' : 'this variable'}`
                        : 'Value'}
                    </label>
                    <textarea
                      value={plaintextValue}
                      onChange={(e) => setPlaintextValue(e.target.value)}
                      placeholder={isMissingRef ? 'Enter the value...' : 'Paste the actual value here...'}
                      rows={3}
                      className="input font-mono text-sm"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm text-slate-400 mb-1">
                    {isMissingRef ? 'Referenced in' : 'Affected Files'}
                  </label>
                  <div className="space-y-1">
                    {reviewSuggestion.affectedFiles.map((f) => (
                      <label
                        key={f.id}
                        className={`flex items-center gap-2 text-sm ${isMissingRef ? 'pl-1' : ''}`}
                      >
                        {!isMissingRef && (
                          <input
                            type="checkbox"
                            checked={selectedFileIds.includes(f.id)}
                            onChange={() => toggleFileId(f.id)}
                            className="w-4 h-4 rounded border-slate-600 bg-slate-800"
                          />
                        )}
                        <span className="text-white">{f.name}</span>
                        <span className="text-slate-500">({f.occurrences} occurrence{f.occurrences > 1 ? 's' : ''})</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={closeReview} className="btn btn-ghost">Cancel</button>
                  {isMissingRef ? (
                    <button
                      onClick={handleApply}
                      disabled={applying || !plaintextValue.trim()}
                      className="btn btn-primary"
                    >
                      {applying ? 'Creating...' : `Create ${editedType}`}
                    </button>
                  ) : (
                    <button
                      onClick={handlePreview}
                      disabled={
                        previewLoading ||
                        (!plaintextValue.trim() && !reviewSuggestion.existingSecretId) ||
                        selectedFileIds.length === 0
                      }
                      className="btn btn-primary"
                    >
                      {previewLoading ? 'Loading...' : 'Preview Changes'}
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Step 2: Preview diffs */}
            {reviewStep === 2 && (
              <>
                <div className="space-y-2 max-h-[28rem] overflow-y-auto">
                  {diffs.map((diff) => {
                    const isOpen = !!expandedFiles[diff.fileId];
                    return (
                      <div key={diff.fileId} className="rounded border border-slate-700 overflow-hidden">
                        <button
                          onClick={() => toggleFileExpanded(diff.fileId)}
                          className="w-full flex items-center justify-between bg-slate-800 hover:bg-slate-700/70 px-3 py-1.5 text-sm text-left"
                        >
                          <span className="flex items-center gap-1.5 font-medium text-slate-300 min-w-0">
                            {isOpen ? (
                              <ChevronDownIcon className="w-3.5 h-3.5 flex-shrink-0" />
                            ) : (
                              <ChevronRightIcon className="w-3.5 h-3.5 flex-shrink-0" />
                            )}
                            <span className="truncate">{diff.fileName}</span>
                          </span>
                          <span className="text-xs text-slate-500 flex-shrink-0 ml-2">
                            {diff.replacements} replacement{diff.replacements > 1 ? 's' : ''}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="text-xs font-mono divide-y divide-slate-800">
                            {diff.hunks.map((h, idx) => (
                              <div key={idx} className="flex">
                                <span className="bg-slate-900 text-slate-600 px-2 py-1 text-right select-none w-12 flex-shrink-0">
                                  {h.lineNumber}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="bg-red-500/10 text-red-300 px-2 py-1 whitespace-pre-wrap break-all">
                                    <span className="text-red-500 select-none">- </span>
                                    {h.before || <span className="text-slate-600 italic">(empty)</span>}
                                  </div>
                                  <div className="bg-green-500/10 text-green-300 px-2 py-1 whitespace-pre-wrap break-all">
                                    <span className="text-green-500 select-none">+ </span>
                                    {h.after || <span className="text-slate-600 italic">(empty)</span>}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
                  {isMissingRef ? (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckIcon className="w-4 h-4 text-green-400" />
                      <span className="text-slate-300">
                        Created {editedType} <span className="font-mono text-white">{editedKey}</span>
                      </span>
                    </div>
                  ) : (
                    applyResults.map((r) => (
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
                    ))
                  )}
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
