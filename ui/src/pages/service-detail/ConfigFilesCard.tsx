import type { ServiceFile, SyncResult } from './types';

interface ConfigFilesCardProps {
  attachedFiles: ServiceFile[];
  syncResults: SyncResult[] | null;
  syncing: boolean;
  onAttachFile: () => void;
  onSyncFiles: () => void;
  onViewFileContent: (fileId: string, fileName: string, filename: string) => void;
  onDetachFile: (configFileId: string) => void;
  onDismissSyncResults: () => void;
}

export function ConfigFilesCard({
  attachedFiles,
  syncResults,
  syncing,
  onAttachFile,
  onSyncFiles,
  onViewFileContent,
  onDetachFile,
  onDismissSyncResults,
}: ConfigFilesCardProps) {
  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Config Files</h3>
        <div className="flex gap-2">
          {attachedFiles.length > 0 && (
            <button
              onClick={onSyncFiles}
              disabled={syncing}
              className="btn btn-secondary"
            >
              {syncing ? 'Syncing...' : 'Sync to Server'}
            </button>
          )}
          <button onClick={onAttachFile} className="btn btn-ghost">
            Attach File
          </button>
        </div>
      </div>

      {/* Sync Results */}
      {syncResults && (
        <div className="mb-4 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
          <p className="text-sm text-slate-400 mb-2">Sync Results:</p>
          <div className="space-y-1">
            {syncResults.map((result, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                {result.success ? (
                  <span className="text-green-400">✓</span>
                ) : (
                  <span className="text-red-400">✕</span>
                )}
                <span className="text-white">{result.file}</span>
                <span className="text-slate-500">→</span>
                <code className="text-slate-400 text-xs">{result.targetPath}</code>
                {result.error && (
                  <span className="text-red-400 text-xs">({result.error})</span>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={onDismissSyncResults}
            className="mt-2 text-xs text-slate-400 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {attachedFiles.length > 0 ? (
        <div className="space-y-2">
          {attachedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium">{file.configFile.name}</span>
                  <span className="text-xs text-slate-500">({file.configFile.filename})</span>
                </div>
                <code className="text-sm text-green-400">{file.targetPath}</code>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onViewFileContent(file.configFileId, file.configFile.name, file.configFile.filename)}
                  className="p-1 text-slate-400 hover:text-primary-400"
                  title="View Content"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </button>
                <button
                  onClick={() => onDetachFile(file.configFileId)}
                  className="p-1 text-slate-400 hover:text-red-400"
                  title="Detach"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-slate-400 text-sm">
          No config files attached. Attach files to sync docker-compose, Caddyfile, certificates, etc.
        </p>
      )}
    </div>
  );
}
