import { useEffect, useState } from 'react';
import { getCliDownloads, getCliDownloadUrl, type CliDownload } from '../../lib/api';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
      />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

export default function CliDownloads() {
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [cliDownloads, setCliDownloads] = useState<CliDownload[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCliDownloads()
      .then((data) => {
        setCliVersion(data.version);
        setCliDownloads(data.downloads);
      })
      .catch(() => {
        setCliVersion(null);
        setCliDownloads([]);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-7 w-48 bg-slate-700 rounded mb-5"></div>
          <div className="h-64 bg-slate-800 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-5">
        <p className="text-slate-400">
          Download the BridgePort CLI to manage your infrastructure from the terminal
        </p>
      </div>

      <div className="panel max-w-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-primary-900/50 rounded-lg flex items-center justify-center">
            <TerminalIcon className="w-6 h-6 text-primary-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">BridgePort CLI</h2>
            {cliVersion && (
              <p className="text-sm text-slate-400">Version {cliVersion}</p>
            )}
          </div>
        </div>

        {cliDownloads.length > 0 ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
              {cliDownloads.map((download) => (
                <a
                  key={`${download.os}-${download.arch}`}
                  href={getCliDownloadUrl(download.os, download.arch)}
                  className="flex items-center justify-between p-4 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors group border border-slate-700 hover:border-slate-600"
                >
                  <div className="flex items-center gap-3">
                    <DownloadIcon className="w-5 h-5 text-slate-400 group-hover:text-primary-400 transition-colors" />
                    <div>
                      <p className="text-white font-medium">{download.label}</p>
                      <p className="text-slate-500 text-sm">{formatBytes(download.size)}</p>
                    </div>
                  </div>
                </a>
              ))}
            </div>

            <div className="border-t border-slate-700 pt-4">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Installation</h3>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-slate-500 mb-1">1. Download for your platform</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">2. Make executable and move to PATH</p>
                  <code className="block bg-slate-800 px-3 py-2 rounded text-sm text-slate-300 font-mono">
                    chmod +x bridgeport-* && sudo mv bridgeport-* /usr/local/bin/bridgeport
                  </code>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">3. Login to BridgePort</p>
                  <code className="block bg-slate-800 px-3 py-2 rounded text-sm text-slate-300 font-mono">
                    bridgeport login
                  </code>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-slate-400">CLI downloads not available</p>
            <p className="text-sm text-slate-500 mt-1">
              CLI binaries may not be bundled in this deployment
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
