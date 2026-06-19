import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore, useAppStore } from './lib/store';
import { api } from './lib/api';
import { setSentryUser, setSentryEnvironment } from './lib/sentry';
// Layout / auth wrappers stay eager — they're needed for the first paint.
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';
import Login from './pages/Login';
import { BrandLoader } from './components/Logo';

// Page components are lazy-loaded so each route ships in its own chunk
// (route-level code splitting), keeping the initial JS bundle small.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Servers = lazy(() => import('./pages/Servers'));
const ServerDetail = lazy(() => import('./pages/ServerDetail'));
const Services = lazy(() => import('./pages/Services'));
const ServiceDetail = lazy(() => import('./pages/ServiceDetail'));
const Secrets = lazy(() => import('./pages/Secrets'));
const ConfigFiles = lazy(() => import('./pages/ConfigFiles'));
const Fragments = lazy(() => import('./pages/Fragments'));
const Registries = lazy(() => import('./pages/Registries'));
const Databases = lazy(() => import('./pages/Databases'));
const DatabaseDetail = lazy(() => import('./pages/DatabaseDetail'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const MonitoringHealth = lazy(() => import('./pages/MonitoringHealth'));
const MonitoringAgents = lazy(() => import('./pages/MonitoringAgents'));
const MonitoringServers = lazy(() => import('./pages/MonitoringServers'));
const MonitoringServices = lazy(() => import('./pages/MonitoringServices'));
const MonitoringDatabases = lazy(() => import('./pages/MonitoringDatabases'));
const Settings = lazy(() => import('./pages/Settings'));
const Notifications = lazy(() => import('./pages/Notifications'));
const ContainerImages = lazy(() => import('./pages/ContainerImages'));
const ContainerImageDetail = lazy(() => import('./pages/ContainerImageDetail'));
const DeploymentPlans = lazy(() => import('./pages/DeploymentPlans'));
const DeploymentPlanDetail = lazy(() => import('./pages/DeploymentPlanDetail'));

// Admin pages
const AdminSystemSettings = lazy(() => import('./pages/admin/SystemSettings'));
const AdminServiceTypes = lazy(() => import('./pages/admin/ServiceTypes'));
const AdminDatabaseTypes = lazy(() => import('./pages/admin/DatabaseTypes'));
const AdminStorage = lazy(() => import('./pages/admin/Storage'));
const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminAudit = lazy(() => import('./pages/admin/Audit'));
const AdminNotificationSettings = lazy(() => import('./pages/admin/NotificationSettings'));
const AdminAbout = lazy(() => import('./pages/admin/About'));
const AdminIntegrations = lazy(() => import('./pages/admin/Integrations'));
const AdminMcp = lazy(() => import('./pages/admin/Mcp'));

// Centered-spinner fallback shown while a lazily-loaded page chunk loads.
function PageFallback() {
  return (
    <div className="flex items-center justify-center h-96">
      <BrandLoader className="size-12" />
    </div>
  );
}

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
              <Suspense fallback={<PageFallback />}>
                <Routes>
                  <Route index element={<Navigate to="/admin/about" replace />} />
                  <Route path="system" element={<AdminSystemSettings />} />
                  <Route path="service-types" element={<AdminServiceTypes />} />
                  <Route path="database-types" element={<AdminDatabaseTypes />} />
                  <Route path="storage" element={<AdminStorage />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="audit" element={<AdminAudit />} />
                  <Route path="notifications" element={<AdminNotificationSettings />} />
                  <Route path="integrations" element={<AdminIntegrations />} />
                  <Route path="mcp" element={<AdminMcp />} />
                  <Route path="about" element={<AdminAbout />} />
                </Routes>
              </Suspense>
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
              <Suspense fallback={<PageFallback />}>
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
                  <Route path="/fragments" element={<Fragments />} />
                  <Route path="/registries" element={<Registries />} />
                  <Route path="/container-images" element={<ContainerImages />} />
                  <Route path="/container-images/:id" element={<ContainerImageDetail />} />
                  <Route path="/deployment-plans" element={<DeploymentPlans />} />
                  <Route path="/deployment-plans/:id" element={<DeploymentPlanDetail />} />
                  <Route path="/databases" element={<Databases />} />
                  <Route path="/databases/:id" element={<DatabaseDetail />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Suspense>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
