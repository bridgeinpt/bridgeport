import { useEffect, useState } from 'react';
import { Download, Terminal } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton } from '@/components/ui/copy-button';
import { getCliDownloads, getCliDownloadUrl, type CliDownload } from '../lib/api';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>BRIDGEPORT CLI</DialogTitle>
          {cliVersion && <DialogDescription>Version {cliVersion}</DialogDescription>}
        </DialogHeader>

        {loading ? (
          <div className="animate-pulse">
            <div className="h-32 bg-muted rounded-lg"></div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 bg-primary/15 rounded-lg flex items-center justify-center">
                <Terminal className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-muted-foreground text-sm">
                  Download the CLI to manage your infrastructure from the terminal
                </p>
              </div>
            </div>

            {cliDownloads.length > 0 ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
                  {cliDownloads.map((download) => (
                    <a
                      key={`${download.os}-${download.arch}`}
                      href={getCliDownloadUrl(download.os, download.arch)}
                      className="flex items-center justify-between p-4 rounded-lg bg-muted hover:bg-accent transition-colors group border border-border hover:border-border/80"
                    >
                      <div className="flex items-center gap-3">
                        <Download className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                        <div>
                          <p className="text-foreground font-medium">{download.label}</p>
                          <p className="text-muted-foreground text-sm">{formatBytes(download.size)}</p>
                        </div>
                      </div>
                    </a>
                  ))}
                </div>

                <div className="border-t border-border pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-foreground">Installation</h3>
                    <Tabs value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                      <TabsList>
                        <TabsTrigger value="macos">macOS</TabsTrigger>
                        <TabsTrigger value="linux">Linux</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                  <div className="space-y-3">
                    {steps.map((step, idx) => (
                      <div key={idx}>
                        <p className="text-xs text-muted-foreground mb-1">
                          {idx + 1}. {step.label}
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="block flex-1 bg-muted px-3 py-2 rounded text-sm text-muted-foreground font-mono">
                            {step.code}
                          </code>
                          <CopyButton value={step.code} variant="outline" />
                        </div>
                        {step.hint && (
                          <p className="text-xs text-muted-foreground mt-1 italic">{step.hint}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-8">
                <p className="text-muted-foreground">CLI downloads not available</p>
                <p className="text-sm text-muted-foreground mt-1">
                  CLI binaries may not be bundled in this deployment
                </p>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CLIModal;
