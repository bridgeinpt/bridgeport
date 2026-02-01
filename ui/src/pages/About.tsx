export default function About() {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="card text-center">
        {/* Logo and Title */}
        <div className="mb-6">
          <img
            src="/logo.svg"
            alt="BridgePort"
            className="h-16 w-16 mx-auto mb-4"
          />
          <h1 className="text-3xl font-bold text-white">BridgePort</h1>
          <p className="text-primary-400 mt-1 font-medium">
            Dock. Run. Ship. Repeat.
          </p>
          <p className="text-slate-500 text-sm mt-2">v1.0.0</p>
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
