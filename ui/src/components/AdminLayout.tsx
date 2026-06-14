import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore, isAdmin } from '../lib/store';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import AdminSidebar from './AdminSidebar';
import { AccountModal } from './AccountModal';
import { CLIModal } from './CLIModal';
import { CommandPalette } from './CommandPalette';
import AdminTopBar from './AdminTopBar';

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user } = useAuthStore();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showCLIModal, setShowCLIModal] = useState(false);

  // Redirect non-admins to home
  if (!isAdmin(user)) {
    return <Navigate to="/" replace />;
  }

  return (
    <SidebarProvider>
      <AdminSidebar />
      <SidebarInset className="h-screen overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <AdminTopBar onOpenAccount={() => setShowAccountModal(true)} onOpenCLI={() => setShowCLIModal(true)} />
        </header>

        <main className="flex-1 overflow-auto">{children}</main>
      </SidebarInset>

      <AccountModal isOpen={showAccountModal} onClose={() => setShowAccountModal(false)} />
      <CLIModal isOpen={showCLIModal} onClose={() => setShowCLIModal(false)} />
      <CommandPalette />
    </SidebarProvider>
  );
}
