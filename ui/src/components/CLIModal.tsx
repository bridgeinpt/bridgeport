import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { getCliDownloads, getCliDownloadUrl, type CliDownload } from '../lib/api';

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

interface CLIModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Platform = 'macos' | 'linux';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? 'macos' : 'linux';
}

function platformInstructions(platform: Platform, filename: string | null) {
  const binary = filename ?? (platform === 'macos' ? 'bridgeport-darwin-arm64' : 'bridgeport-linux-amd64');
  if (platform === 'macos') {
    return {
      steps: [
        {
          label: 'Make the binary executable',
          code: `chmod +x ~/Downloads/${binary}`,
        },
        {
          label: 'Remove the Gatekeeper quarantine flag',
          code: `xattr -d com.apple.quarantine ~/Downloads/${binary}`,
          hint: 'macOS blocks downloaded binaries until you either clear this attribute or right-click > Open once.',
        },
        {
          label: 'Move it onto your PATH',
          code: `sudo mv ~/Downloads/${binary} /usr/local/bin/bridgeport`,
        },
        {
          label: 'Log in to BRIDGEPORT',
          code: 'bridgeport login',
        },
      ],
    };
  }
  return {
    steps: [
      {
        label: 'Make the binary executable',
        code: `chmod +x ~/Downloads/${binary}`,
      },
      {
        label: 'Move it onto your PATH',
        code: `sudo mv ~/Downloads/${binary} /usr/local/bin/bridgeport`,
        hint: 'Use ~/.local/bin instead if /usr/local/bin is not writable on your distribution.',
      },
      {
        label: 'Log in to BRIDGEPORT',
        code: 'bridgeport login',
      },
    ],
  };
}

export function CLIModal({ isOpen, onClose }: CLIModalProps) {
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [cliDownloads, setCliDownloads] = useState<CliDownload[]>([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
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
  }, [isOpen]);

  const platformFilename =
    cliDownloads.find((d) => d.os === (platform === 'macos' ? 'darwin' : 'linux'))?.filename ?? null;
  const { steps } = platformInstructions(platform, platformFilename);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="BRIDGEPORT CLI"
      subtitle={cliVersion ? `Version ${cliVersion}` : undefined}
      size="lg"
    >
      {loading ? (
        <div className="animate-pulse">
          <div className="h-32 bg-slate-800 rounded-lg"></div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-primary-900/50 rounded-lg flex items-center justify-center">
              <TerminalIcon className="w-6 h-6 text-primary-400" />
            </div>
            <div>
              <p className="text-slate-400 text-sm">
                Download the CLI to manage your infrastructure from the terminal
              </p>
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
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-slate-300">Installation</h3>
                  <div className="flex gap-1 bg-slate-800/50 rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => setPlatform('macos')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        platform === 'macos'
                          ? 'bg-slate-700 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      macOS
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlatform('linux')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        platform === 'linux'
                          ? 'bg-slate-700 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Linux
                    </button>
                  </div>
                </div>
                <div className="space-y-3">
                  {steps.map((step, idx) => (
                    <div key={idx}>
                      <p className="text-xs text-slate-500 mb-1">
                        {idx + 1}. {step.label}
                      </p>
                      <code className="block bg-slate-800 px-3 py-2 rounded text-sm text-slate-300 font-mono">
                        {step.code}
                      </code>
                      {step.hint && (
                        <p className="text-xs text-slate-500 mt-1 italic">{step.hint}</p>
                      )}
                    </div>
                  ))}
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
        </>
      )}
    </Modal>
  );
}

export default CLIModal;
