import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  runServerBootstrap,
  type BootstrapComponents,
  type BootstrapStatus,
} from '../lib/api';
import { useEventSource } from '../lib/useEventSource';
import { useToast } from './Toast';

interface BootstrapProgressEvent {
  serverId: string;
  environmentId: string;
  component?: 'docker' | 'sysctl' | 'agent' | 'swap' | 'distro' | 'preflight';
  phase: 'start' | 'step' | 'done' | 'error';
  level: 'info' | 'error';
  line: string;
}

interface BootstrapModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: string;
  status: BootstrapStatus | null;
  onComplete?: () => void;
}

interface LogLine {
  text: string;
  level: 'info' | 'error';
  ts: number;
}

const DEFAULT_SWAP_MB = 2048;

export function BootstrapModal({
  isOpen,
  onClose,
  serverId,
  status,
  onComplete,
}: BootstrapModalProps) {
  const toast = useToast();
  const [components, setComponents] = useState<BootstrapComponents>({
    docker: true,
    sysctl: true,
    agent: true,
    swap: false,
  });
  const [swapSizeMb, setSwapSizeMb] = useState<number>(DEFAULT_SWAP_MB);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Reset state when the modal opens fresh.
  useEffect(() => {
    if (isOpen) {
      setLogs([]);
      setFinished(false);
      setRunning(false);
    }
  }, [isOpen]);

  // Subscribe to bootstrap_progress SSE events scoped to this server.
  useEventSource('bootstrap_progress', (raw) => {
    const ev = raw as BootstrapProgressEvent;
    if (ev.serverId !== serverId) return;
    setLogs((prev) => [...prev, { text: ev.line, level: ev.level, ts: Date.now() }]);
    if (ev.phase === 'done' && !ev.component) {
      setRunning(false);
      setFinished(true);
      onComplete?.();
    } else if (ev.phase === 'error' && !ev.component) {
      setRunning(false);
      setFinished(true);
    }
  });

  // Auto-scroll log pane to bottom as new lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const sudoOk = status?.sudo?.ok ?? false;
  const distroSupported = status?.distro?.supported ?? false;
  const distroRaw = status?.distro?.raw || status?.bootstrapDistro || 'unknown';

  // Disable submission if nothing selected, or swap selected without a size.
  const anyComponent = useMemo(
    () => Boolean(components.docker || components.sysctl || components.agent || components.swap),
    [components],
  );
  const swapNeedsSize = Boolean(components.swap) && (!swapSizeMb || swapSizeMb < 128);
  const canSubmit = anyComponent && !swapNeedsSize && !running;

  const handleStart = async () => {
    setRunning(true);
    setFinished(false);
    setLogs([]);
    try {
      await runServerBootstrap(serverId, {
        components,
        swapSizeMb: components.swap ? swapSizeMb : undefined,
      });
      toast.success('Bootstrap started');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bootstrap failed to start';
      toast.error(msg);
      setRunning(false);
      setLogs((prev) => [...prev, { text: msg, level: 'error', ts: Date.now() }]);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={running ? () => {} : onClose}
      title="Bootstrap Server"
      subtitle="Install Docker, configure sysctl, deploy the agent, and optionally add swap"
      size="2xl"
      showCloseButton={!running}
    >
      <div className="space-y-4">
        {/* Sudo / distro banner */}
        <div
          className={`p-3 rounded-lg text-sm ${
            sudoOk && distroSupported
              ? 'bg-slate-800/50 border border-slate-700 text-slate-300'
              : 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-300'
          }`}
        >
          <div className="flex flex-col gap-1">
            <div>
              <span className="text-slate-400">Distro:</span>{' '}
              <span className="font-mono">{distroRaw}</span>{' '}
              {distroSupported ? (
                <span className="text-green-400">(supported)</span>
              ) : (
                <span className="text-yellow-400">(unsupported — Ubuntu/Debian only)</span>
              )}
            </div>
            <div>
              <span className="text-slate-400">Passwordless sudo:</span>{' '}
              {sudoOk ? (
                <span className="text-green-400">OK</span>
              ) : (
                <span className="text-yellow-400">
                  not detected{status?.sudo?.error ? ` — ${status.sudo.error}` : ''}
                </span>
              )}
            </div>
            {!sudoOk && (
              <p className="text-xs text-yellow-200/80 mt-1">
                Bootstrap requires passwordless sudo (NOPASSWD) or root SSH access.
              </p>
            )}
          </div>
        </div>

        {/* Component selection */}
        <div>
          <p className="text-sm text-slate-400 mb-2">Components</p>
          <div className="grid grid-cols-2 gap-3">
            {(['docker', 'sysctl', 'agent', 'swap'] as const).map((key) => (
              <label
                key={key}
                className={`flex items-start gap-3 p-3 rounded-lg border ${
                  components[key]
                    ? 'border-primary-500/50 bg-primary-500/5'
                    : 'border-slate-700 bg-slate-800/50'
                } ${running ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={Boolean(components[key])}
                  disabled={running}
                  onChange={(e) =>
                    setComponents((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-white font-medium capitalize">{key}</div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {key === 'docker' &&
                      'Install Docker Engine + Compose plugin via get.docker.com'}
                    {key === 'sysctl' &&
                      'Write /etc/sysctl.d/99-bridgeport.conf (vm.swappiness, fs.file-max)'}
                    {key === 'agent' && 'Deploy the BridgePort monitoring agent'}
                    {key === 'swap' && 'Create /swapfile and persist via /etc/fstab'}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Swap size input */}
        {components.swap && (
          <div>
            <label className="block text-sm text-slate-400 mb-1">Swap size (MB)</label>
            <input
              type="number"
              min={128}
              max={65536}
              step={128}
              value={swapSizeMb}
              disabled={running}
              onChange={(e) => setSwapSizeMb(parseInt(e.target.value || '0', 10))}
              className="input w-40 font-mono"
            />
            <p className="text-xs text-slate-500 mt-1">Range: 128 - 65536 MB.</p>
          </div>
        )}

        {/* Log pane */}
        {(running || logs.length > 0) && (
          <div>
            <p className="text-sm text-slate-400 mb-2">Progress</p>
            <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 max-h-72 overflow-y-auto font-mono text-xs">
              {logs.length === 0 ? (
                <p className="text-slate-500">Waiting for output...</p>
              ) : (
                logs.map((l, i) => (
                  <div
                    key={i}
                    className={l.level === 'error' ? 'text-red-400' : 'text-slate-300'}
                  >
                    {l.text}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {/* Footer actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="btn btn-ghost"
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button
              type="button"
              onClick={handleStart}
              disabled={!canSubmit || !sudoOk || !distroSupported}
              className="btn btn-primary"
            >
              {running ? 'Running...' : 'Start Bootstrap'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default BootstrapModal;
