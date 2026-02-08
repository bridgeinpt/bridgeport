// App version is baked in at build time via Vite
const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';

export default function About() {

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="card text-center">
        {/* Logo and Title */}
        <div className="mb-6">
          <img
            src="/logo.png"
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
              <DeployIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Deployment orchestration with auto-rollback
            </li>
            <li className="flex items-center gap-3">
              <ChartIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Server, service &amp; database monitoring
            </li>
            <li className="flex items-center gap-3">
              <HeartIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Health checks &amp; agent monitoring
            </li>
            <li className="flex items-center gap-3">
              <DatabaseIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Database backups &amp; monitoring
            </li>
            <li className="flex items-center gap-3">
              <LockIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Secret &amp; config file management
            </li>
            <li className="flex items-center gap-3">
              <BellIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Multi-channel notifications
            </li>
            <li className="flex items-center gap-3">
              <TopologyIcon className="w-5 h-5 text-primary-400 flex-shrink-0" />
              Interactive service topology
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
          &copy; 2024-2026 BridgeIn. All rights reserved.
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

function DeployIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
    </svg>
  );
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}

function TopologyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
    </svg>
  );
}
