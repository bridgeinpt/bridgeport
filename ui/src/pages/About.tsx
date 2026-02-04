import { useEffect, useState } from 'react';
import { getCliDownloads, getCliDownloadUrl, type CliDownload } from '../lib/api';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// App version is baked in at build time via Vite
const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';

export default function About() {
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [cliDownloads, setCliDownloads] = useState<CliDownload[]>([]);

  useEffect(() => {
    getCliDownloads()
      .then((data) => {
        setCliVersion(data.version);
        setCliDownloads(data.downloads);
      })
      .catch(() => {
        setCliVersion(null);
        setCliDownloads([]);
      });
  }, []);

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="card text-center">
        {/* Logo and Title */}
        <div className="mb-6">
          <img
            src="/logo.svg"
            alt="BridgePort"
            className="h-28 mx-auto mb-4"
          />
          <p className="text-primary-400 mt-1 font-medium">
            Dock. Run. Ship. Repeat.
          </p>
          <p className="text-slate-500 text-sm mt-2">v{appVersion}</p>
        </div>

        <div className="border-t border-slate-700 my-6" />

        {/* Description */}
        <div className="text-left mb-6">
          <p className="text-slate-300">
            A lightweight deployment management tool for teams who want simple,
            reliable container orchestration without enterprise complexity.
          </p>
        </div>

        {/* Features */}
        <div className="text-left mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Features
          </h2>
          <ul className="space-y-2 text-slate-300">
            <li className="flex items-center gap-3">
              <AnchorIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Multi-environment management
            </li>
            <li className="flex items-center gap-3">
              <ContainerIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Docker service orchestration
            </li>
            <li className="flex items-center gap-3">
              <LockIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Secret management
            </li>
            <li className="flex items-center gap-3">
              <ChartIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Real-time activity monitoring
            </li>
            <li className="flex items-center gap-3">
              <FileIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Config file distribution
            </li>
          </ul>
        </div>

        {/* CLI Downloads */}
        {cliDownloads.length > 0 && (
          <>
            <div className="border-t border-slate-700 my-6" />
            <div className="text-left mb-6">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">
                CLI Tool {cliVersion && <span className="text-slate-500 font-normal">v{cliVersion}</span>}
              </h2>
              <p className="text-slate-400 text-sm mb-4">
                Download the BridgePort CLI to manage your infrastructure from the terminal.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {cliDownloads.map((download) => (
                  <a
                    key={`${download.os}-${download.arch}`}
                    href={getCliDownloadUrl(download.os, download.arch)}
                    className="flex items-center justify-between p-3 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <DownloadIcon className="w-5 h-5 text-slate-400 group-hover:text-primary-400" />
                      <div>
                        <p className="text-white text-sm font-medium">{download.label}</p>
                        <p className="text-slate-500 text-xs">{formatBytes(download.size)}</p>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
              <p className="text-slate-500 text-xs mt-3">
                After downloading, make it executable: <code className="bg-slate-800 px-1.5 py-0.5 rounded">chmod +x bridgeport-*</code>
              </p>
            </div>
          </>
        )}

        <div className="border-t border-slate-700 my-6" />

        {/* Credits */}
        <div className="text-center">
          <p className="text-slate-400 text-sm mb-3">
            Created with{' '}
            <span className="text-red-400">&#10084;</span> by the Engineering
            Team at
          </p>
          <a
            href="https://bridgein.pt"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-white font-bold text-xl hover:text-primary-400 transition-colors"
          >
            BRIDGEIN
          </a>
          <p className="text-slate-500 text-sm mt-1">bridgein.pt</p>
        </div>

        <div className="border-t border-slate-700 my-6" />

        {/* Copyright */}
        <p className="text-slate-500 text-xs">
          &copy; 2024-2025 BridgeIn. All rights reserved.
        </p>
      </div>
    </div>
  );
}

function AnchorIcon({ className }: { className?: string }) {
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
        d="M12 21V11m0 0V7m0 4h4m-4 0H8m4-4a2 2 0 100-4 2 2 0 000 4zm-7 7a7 7 0 1014 0"
      />
    </svg>
  );
}

function ContainerIcon({ className }: { className?: string }) {
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
        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
      />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
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
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
      />
    </svg>
  );
}

function ChartIcon({ className }: { className?: string }) {
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
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
      />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
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
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
      />
    </svg>
  );
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
