import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore, useAppStore } from './lib/store';
import { api } from './lib/api';
import { setSentryUser, setSentryEnvironment } from './lib/sentry';
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Servers from './pages/Servers';
import ServerDetail from './pages/ServerDetail';
import Services from './pages/Services';
import ServiceDetail from './pages/ServiceDetail';
import Secrets from './pages/Secrets';
import ConfigFiles from './pages/ConfigFiles';
import Registries from './pages/Registries';
import Databases from './pages/Databases';
import DatabaseDetail from './pages/DatabaseDetail';
import Monitoring from './pages/Monitoring';
import MonitoringHealth from './pages/MonitoringHealth';
import MonitoringAgents from './pages/MonitoringAgents';
import MonitoringServers from './pages/MonitoringServers';
import MonitoringServices from './pages/MonitoringServices';
import MonitoringDatabases from './pages/MonitoringDatabases';
import Settings from './pages/Settings';
import Notifications from './pages/Notifications';
import ContainerImages from './pages/ContainerImages';
import DeploymentPlans from './pages/DeploymentPlans';
import DeploymentPlanDetail from './pages/DeploymentPlanDetail';

// Admin pages
import AdminSystemSettings from './pages/admin/SystemSettings';
import AdminServiceTypes from './pages/admin/ServiceTypes';
import AdminDatabaseTypes from './pages/admin/DatabaseTypes';
import AdminStorage from './pages/admin/Storage';
import AdminUsers from './pages/admin/Users';
import AdminAudit from './pages/admin/Audit';
import AdminNotificationSettings from './pages/admin/NotificationSettings';
import AdminAbout from './pages/admin/About';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  const selectedEnvironment = useAppStore((s) => s.selectedEnvironment);

  useEffect(() => {
    if (user) {
      setSentryUser({ id: user.id });
    } else {
      setSentryUser(null);
    }
  }, [user]);

  useEffect(() => {
    if (selectedEnvironment) {
      setSentryEnvironment({ id: selectedEnvironment.id, name: selectedEnvironment.name });
    } else {
      setSentryEnvironment(null);
    }
  }, [selectedEnvironment]);

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

      {/* Admin Routes */}
      <Route
        path="/admin/*"
        element={
          <ProtectedRoute>
            <AdminLayout>
              <Routes>
                <Route index element={<Navigate to="/admin/about" replace />} />
                <Route path="system" element={<AdminSystemSettings />} />
                <Route path="service-types" element={<AdminServiceTypes />} />
                <Route path="database-types" element={<AdminDatabaseTypes />} />
                <Route path="storage" element={<AdminStorage />} />
                <Route path="users" element={<AdminUsers />} />
                <Route path="audit" element={<AdminAudit />} />
                <Route path="notifications" element={<AdminNotificationSettings />} />
                <Route path="about" element={<AdminAbout />} />
              </Routes>
            </AdminLayout>
          </ProtectedRoute>
        }
      />

      {/* Main App Routes */}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/monitoring" element={<Monitoring />} />
                <Route path="/monitoring/servers" element={<MonitoringServers />} />
                <Route path="/monitoring/services" element={<MonitoringServices />} />
                <Route path="/monitoring/databases" element={<MonitoringDatabases />} />
                <Route path="/monitoring/health" element={<MonitoringHealth />} />
                <Route path="/monitoring/agents" element={<MonitoringAgents />} />
                <Route path="/servers" element={<Servers />} />
                <Route path="/servers/:id" element={<ServerDetail />} />
                <Route path="/services" element={<Services />} />
                <Route path="/services/:id" element={<ServiceDetail />} />
                <Route path="/secrets" element={<Secrets />} />
                <Route path="/config-files" element={<ConfigFiles />} />
                <Route path="/registries" element={<Registries />} />
                <Route path="/container-images" element={<ContainerImages />} />
                <Route path="/deployment-plans" element={<DeploymentPlans />} />
                <Route path="/deployment-plans/:id" element={<DeploymentPlanDetail />} />
                <Route path="/databases" element={<Databases />} />
                <Route path="/databases/:id" element={<DatabaseDetail />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
