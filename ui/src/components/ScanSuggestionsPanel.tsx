import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  runConfigScan,
  previewConfigScan,
  applyConfigScan,
  type ConfigScanSuggestion,
  type ConfigScanPreviewDiff,
} from '../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/Toast';
import { getErrorMessage } from '@/lib/helpers';

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
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to run config scan'));
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
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to preview changes'));
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
    } catch (err) {
      toast.error(getErrorMessage(err, isMissingRef ? 'Failed to create' : 'Failed to apply changes'));
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
      <Card className="mb-4 gap-0 py-3">
        <div className="flex items-center justify-between px-6">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <span className="font-medium">Config Scanner</span>
            {hasScanRun && suggestions.length > 0 && (
              <Badge variant="info" className="px-1.5 py-0">
                {suggestions.length}
              </Badge>
            )}
          </button>
          <div className="flex items-center gap-3">
            {lastScanAt && (
              <span className="text-xs text-muted-foreground">
                Scanned {scannedFileCount} files
                {skippedBinaryCount > 0 && ` (${skippedBinaryCount} binary skipped)`}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={handleScan} disabled={scanning}>
              {scanning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {scanning ? 'Scanning...' : 'Run Scan'}
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-3 px-6">
            {!hasScanRun ? (
              <p className="text-sm text-muted-foreground">
                Click "Run Scan" to detect hardcoded values that could be promoted to secrets or variables.
              </p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No suggestions found. Config files look clean.</p>
            ) : (
              <div className="space-y-1">
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={s.proposedType === 'secret' ? 'warning' : 'info'}
                        className="px-1.5 py-0 text-[10px] uppercase"
                      >
                        {s.proposedType}
                      </Badge>
                      <span className="font-mono text-sm text-foreground">{s.proposedKey}</span>
                      {s.kind === 'missing_reference' ? (
                        <span className="flex items-center gap-1 text-xs text-warning">
                          <TriangleAlert className="size-3" />
                          Referenced but not defined ({s.occurrenceCount}× in {s.affectedFiles.length} file{s.affectedFiles.length > 1 ? 's' : ''})
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {s.existingSecretKey
                            ? `Replace with existing ${s.existingSecretKey}`
                            : `${s.occurrenceCount}× in ${s.affectedFiles.length} file${s.affectedFiles.length > 1 ? 's' : ''}`}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="xs" onClick={() => openReview(s)}>
                        {s.kind === 'missing_reference' ? 'Define' : 'Review'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => dismissSuggestion(s)}
                        title="Dismiss"
                        aria-label="Dismiss suggestion"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Review Modal */}
      <Dialog open={!!reviewSuggestion} onOpenChange={(open) => !open && closeReview()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{modalTitle()}</DialogTitle>
          </DialogHeader>
          {reviewSuggestion && (
            <div className="space-y-4">
              {/* Step 1: Confirm details */}
              {reviewStep === 1 && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="scan-key-name">Key Name</Label>
                    <Input
                      id="scan-key-name"
                      type="text"
                      value={editedKey}
                      onChange={(e) => setEditedKey(e.target.value.toUpperCase())}
                      pattern="^[A-Z][A-Z0-9_]*$"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="scan-type">Type</Label>
                    <Select
                      value={editedType}
                      onValueChange={(v) => setEditedType(v as 'secret' | 'var')}
                    >
                      <SelectTrigger id="scan-type" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="secret">Secret (encrypted)</SelectItem>
                        <SelectItem value="var">Var (plaintext)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {!reviewSuggestion.existingSecretId && (
                    <div className="space-y-1">
                      <Label htmlFor="scan-value">
                        {isMissingRef
                          ? `Value for ${editedType === 'secret' ? 'this secret' : 'this variable'}`
                          : 'Value'}
                      </Label>
                      <Textarea
                        id="scan-value"
                        value={plaintextValue}
                        onChange={(e) => setPlaintextValue(e.target.value)}
                        placeholder={isMissingRef ? 'Enter the value...' : 'Paste the actual value here...'}
                        rows={3}
                        className="font-mono text-sm"
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label>{isMissingRef ? 'Referenced in' : 'Affected Files'}</Label>
                    <div className="space-y-1">
                      {reviewSuggestion.affectedFiles.map((f) => (
                        <label
                          key={f.id}
                          className={`flex items-center gap-2 text-sm ${isMissingRef ? 'pl-1' : ''}`}
                        >
                          {!isMissingRef && (
                            <Checkbox
                              checked={selectedFileIds.includes(f.id)}
                              onCheckedChange={() => toggleFileId(f.id)}
                            />
                          )}
                          <span className="text-foreground">{f.name}</span>
                          <span className="text-muted-foreground">({f.occurrences} occurrence{f.occurrences > 1 ? 's' : ''})</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={closeReview}>
                      Cancel
                    </Button>
                    {isMissingRef ? (
                      <Button onClick={handleApply} disabled={applying || !plaintextValue.trim()}>
                        {applying ? 'Creating...' : `Create ${editedType}`}
                      </Button>
                    ) : (
                      <Button
                        onClick={handlePreview}
                        disabled={
                          previewLoading ||
                          (!plaintextValue.trim() && !reviewSuggestion.existingSecretId) ||
                          selectedFileIds.length === 0
                        }
                      >
                        {previewLoading ? 'Loading...' : 'Preview Changes'}
                      </Button>
                    )}
                  </DialogFooter>
                </>
              )}

              {/* Step 2: Preview diffs */}
              {reviewStep === 2 && (
                <>
                  <div className="max-h-[28rem] space-y-2 overflow-y-auto">
                    {diffs.map((diff) => {
                      const isOpen = !!expandedFiles[diff.fileId];
                      return (
                        <div key={diff.fileId} className="overflow-hidden rounded border border-border">
                          <button
                            onClick={() => toggleFileExpanded(diff.fileId)}
                            className="flex w-full items-center justify-between bg-muted px-3 py-1.5 text-left text-sm hover:bg-muted/70"
                          >
                            <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                              {isOpen ? (
                                <ChevronDown className="size-3.5 flex-shrink-0" />
                              ) : (
                                <ChevronRight className="size-3.5 flex-shrink-0" />
                              )}
                              <span className="truncate">{diff.fileName}</span>
                            </span>
                            <span className="ml-2 flex-shrink-0 text-xs text-muted-foreground">
                              {diff.replacements} replacement{diff.replacements > 1 ? 's' : ''}
                            </span>
                          </button>
                          {isOpen && (
                            <div className="divide-y divide-border font-mono text-xs">
                              {diff.hunks.map((h, idx) => (
                                <div key={idx} className="flex">
                                  <span className="w-12 flex-shrink-0 select-none bg-muted/50 px-2 py-1 text-right text-muted-foreground">
                                    {h.lineNumber}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="whitespace-pre-wrap break-all bg-destructive/10 px-2 py-1 text-destructive">
                                      <span className="select-none text-destructive">- </span>
                                      {h.before || <span className="italic text-muted-foreground">(empty)</span>}
                                    </div>
                                    <div className="whitespace-pre-wrap break-all bg-success/10 px-2 py-1 text-success">
                                      <span className="select-none text-success">+ </span>
                                      {h.after || <span className="italic text-muted-foreground">(empty)</span>}
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
                  <DialogFooter className="sm:justify-between">
                    <Button variant="ghost" onClick={() => setReviewStep(1)}>
                      Back
                    </Button>
                    <Button onClick={handleApply} disabled={applying}>
                      {applying ? 'Applying...' : 'Apply Changes'}
                    </Button>
                  </DialogFooter>
                </>
              )}

              {/* Step 3: Results */}
              {reviewStep === 3 && (
                <>
                  <div className="space-y-2">
                    {isMissingRef ? (
                      <div className="flex items-center gap-2 text-sm">
                        <Check className="size-4 text-success" />
                        <span className="text-muted-foreground">
                          Created {editedType} <span className="font-mono text-foreground">{editedKey}</span>
                        </span>
                      </div>
                    ) : (
                      applyResults.map((r) => (
                        <div key={r.fileId} className="flex items-center gap-2 text-sm">
                          {r.success ? (
                            <Check className="size-4 text-success" />
                          ) : (
                            <TriangleAlert className="size-4 text-destructive" />
                          )}
                          <span className={r.success ? 'text-muted-foreground' : 'text-destructive'}>
                            {r.fileName}
                            {r.success ? ` — ${r.replacements} replacement${r.replacements > 1 ? 's' : ''}` : ` — ${r.error}`}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <DialogFooter>
                    <Button onClick={closeReview}>Done</Button>
                  </DialogFooter>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
