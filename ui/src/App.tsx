import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './lib/store';
import { api } from './lib/api';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Servers from './pages/Servers';
import ServerDetail from './pages/ServerDetail';
import Services from './pages/Services';
import ServiceDetail from './pages/ServiceDetail';
import Secrets from './pages/Secrets';
import ConfigFiles from './pages/ConfigFiles';
import Activity from './pages/Activity';
import About from './pages/About';
import Registries from './pages/Registries';
import Users from './pages/Users';
import Databases from './pages/Databases';
import Monitoring from './pages/Monitoring';
import Settings from './pages/Settings';
import Notifications from './pages/Notifications';
import NotificationSettings from './pages/admin/NotificationSettings';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // Sync token with API client
  api.setToken(token);

  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/monitoring" element={<Monitoring />} />
                <Route path="/servers" element={<Servers />} />
                <Route path="/servers/:id" element={<ServerDetail />} />
                <Route path="/services" element={<Services />} />
                <Route path="/services/:id" element={<ServiceDetail />} />
                <Route path="/secrets" element={<Secrets />} />
                <Route path="/config-files" element={<ConfigFiles />} />
                <Route path="/registries" element={<Registries />} />
                <Route path="/databases" element={<Databases />} />
                <Route path="/activity" element={<Activity />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/users" element={<Users />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/admin/notifications" element={<NotificationSettings />} />
                <Route path="/about" element={<About />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
