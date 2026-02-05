import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore, isAdmin } from '../lib/store';
import AdminSidebar from './AdminSidebar';
import { AccountModal } from './AccountModal';
import { CLIModal } from './CLIModal';
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
    <div className="h-screen flex overflow-hidden">
      {/* Admin Sidebar */}
      <AdminSidebar />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <AdminTopBar
          onOpenAccount={() => setShowAccountModal(true)}
          onOpenCLI={() => setShowCLIModal(true)}
        />

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>

      {/* Account Modal */}
      <AccountModal isOpen={showAccountModal} onClose={() => setShowAccountModal(false)} />

      {/* CLI Modal */}
      <CLIModal isOpen={showCLIModal} onClose={() => setShowCLIModal(false)} />
    </div>
  );
}
