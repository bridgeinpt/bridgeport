import { useState } from 'react';
import { useAppStore } from '../lib/store';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { AppSidebar } from './AppSidebar';
import { AccountModal } from './AccountModal';
import { CLIModal } from './CLIModal';
import { CommandPalette } from './CommandPalette';
import TopBar from './TopBar';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { selectedEnvironment, sidebarCollapsed, toggleSidebar } = useAppStore();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showCLIModal, setShowCLIModal] = useState(false);

  return (
    <SidebarProvider
      open={!sidebarCollapsed}
      onOpenChange={(open) => {
        // Mirror the sidebar's open state into the persisted zustand flag.
        if (open === sidebarCollapsed) toggleSidebar();
      }}
    >
      <AppSidebar />
      <SidebarInset className="h-screen overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <TopBar onOpenAccount={() => setShowAccountModal(true)} onOpenCLI={() => setShowCLIModal(true)} />
        </header>

        <main className="flex-1 overflow-auto">
          {/* Key forces a remount when the environment changes, resetting local state. */}
          <div key={selectedEnvironment?.id || 'no-env'}>{children}</div>
        </main>
      </SidebarInset>

      <AccountModal isOpen={showAccountModal} onClose={() => setShowAccountModal(false)} />
      <CLIModal isOpen={showCLIModal} onClose={() => setShowCLIModal(false)} />
      <CommandPalette />
    </SidebarProvider>
  );
}
