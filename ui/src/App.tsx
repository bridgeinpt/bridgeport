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
import DatabaseDetail from './pages/DatabaseDetail';
import Monitoring from './pages/Monitoring';
import MonitoringHealth from './pages/MonitoringHealth';
import MonitoringAgents from './pages/MonitoringAgents';
import MonitoringDataStores from './pages/MonitoringDataStores';
import DataStoreDetail from './pages/DataStoreDetail';
import Settings from './pages/Settings';
import Notifications from './pages/Notifications';
import NotificationSettings from './pages/admin/NotificationSettings';
import ContainerImages from './pages/ContainerImages';
import DeploymentPlans from './pages/DeploymentPlans';
import DeploymentPlanDetail from './pages/DeploymentPlanDetail';
import ServiceTypes from './pages/settings/ServiceTypes';
import GlobalSpaces from './pages/settings/GlobalSpaces';
import SystemSettings from './pages/settings/SystemSettings';
import CliDownloads from './pages/settings/CliDownloads';

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
                <Route path="/monitoring/health" element={<MonitoringHealth />} />
                <Route path="/monitoring/agents" element={<MonitoringAgents />} />
                <Route path="/monitoring/data-stores" element={<MonitoringDataStores />} />
                <Route path="/data-stores/:id" element={<DataStoreDetail />} />
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
                <Route path="/activity" element={<Activity />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/users" element={<Users />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/settings/system" element={<SystemSettings />} />
                <Route path="/settings/service-types" element={<ServiceTypes />} />
                <Route path="/settings/spaces" element={<GlobalSpaces />} />
                <Route path="/settings/cli" element={<CliDownloads />} />
                <Route path="/settings/notifications" element={<NotificationSettings />} />
                <Route path="/about" element={<About />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
