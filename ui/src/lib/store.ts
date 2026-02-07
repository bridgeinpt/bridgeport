import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Environment, UserRole } from './api';

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  setUser: (user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      setUser: (user) => set({ user }),
      logout: () => set({ user: null, token: null }),
    }),
    {
      name: 'auth-storage',
    }
  )
);

// Role helpers
export const isAdmin = (user: User | null): boolean => user?.role === 'admin';
export const isOperator = (user: User | null): boolean => user?.role === 'operator';
export const isViewer = (user: User | null): boolean => user?.role === 'viewer';
export const hasMinimumRole = (user: User | null, minimumRole: UserRole): boolean => {
  if (!user) return false;
  const roleHierarchy: Record<UserRole, number> = {
    admin: 3,
    operator: 2,
    viewer: 1,
  };
  return roleHierarchy[user.role] >= roleHierarchy[minimumRole];
};

interface AppState {
  selectedEnvironment: Environment | null;
  setSelectedEnvironment: (env: Environment | null) => void;
  clearSelectedEnvironment: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  // Menu group collapse state (persisted)
  collapsedGroups: string[];
  toggleGroup: (name: string) => void;

  // Monitoring preferences (persisted)
  monitoringTimeRange: number;
  setMonitoringTimeRange: (hours: number) => void;
  autoRefreshEnabled: boolean;
  setAutoRefreshEnabled: (enabled: boolean) => void;
  monitoringServerFilter: string[];
  setMonitoringServerFilter: (ids: string[]) => void;
  monitoringServiceFilter: string[];
  setMonitoringServiceFilter: (ids: string[]) => void;
  monitoringDatabaseFilter: string[];
  setMonitoringDatabaseFilter: (ids: string[]) => void;

  // Breadcrumb name resolution (session-only, not persisted)
  breadcrumbNames: Record<string, string>;
  setBreadcrumbName: (id: string, name: string) => void;

  // Dashboard alert dismissals (session-only, not persisted)
  dismissedAlerts: string[];
  dismissAlert: (alertId: string) => void;
  clearDismissedAlerts: () => void;

  // Page filter preferences (persisted)
  servicesShowUpdatesOnly: boolean;
  setServicesShowUpdatesOnly: (value: boolean) => void;
  configFilesAttachedFilter: boolean;
  setConfigFilesAttachedFilter: (value: boolean) => void;
  configFilesServiceFilter: string | null;
  setConfigFilesServiceFilter: (serviceId: string | null) => void;
  activityResourceTypeFilter: string;
  setActivityResourceTypeFilter: (type: string) => void;
  monitoringHealthType: string;
  setMonitoringHealthType: (type: string) => void;
  monitoringHealthStatus: string;
  setMonitoringHealthStatus: (status: string) => void;
  monitoringHealthTab: 'status' | 'logs';
  setMonitoringHealthTab: (tab: 'status' | 'logs') => void;
  monitoringDatabaseTypeTab: string;
  setMonitoringDatabaseTypeTab: (type: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedEnvironment: null,
      setSelectedEnvironment: (env) => set({ selectedEnvironment: env }),
      clearSelectedEnvironment: () => set({ selectedEnvironment: null }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      // Menu group collapse state
      collapsedGroups: [],
      toggleGroup: (name) =>
        set((state) => ({
          collapsedGroups: state.collapsedGroups.includes(name)
            ? state.collapsedGroups.filter((g) => g !== name)
            : [...state.collapsedGroups, name],
        })),

      // Monitoring preferences
      monitoringTimeRange: 24,
      setMonitoringTimeRange: (hours) => set({ monitoringTimeRange: hours }),
      autoRefreshEnabled: true,
      setAutoRefreshEnabled: (enabled) => set({ autoRefreshEnabled: enabled }),
      monitoringServerFilter: [],
      setMonitoringServerFilter: (ids) => set({ monitoringServerFilter: ids }),
      monitoringServiceFilter: [],
      setMonitoringServiceFilter: (ids) => set({ monitoringServiceFilter: ids }),
      monitoringDatabaseFilter: [],
      setMonitoringDatabaseFilter: (ids) => set({ monitoringDatabaseFilter: ids }),

      // Breadcrumb name resolution (session-only)
      breadcrumbNames: {},
      setBreadcrumbName: (id, name) =>
        set((state) => ({
          breadcrumbNames: { ...state.breadcrumbNames, [id]: name },
        })),

      // Dashboard alert dismissals (session-only)
      dismissedAlerts: [],
      dismissAlert: (alertId) =>
        set((state) => ({
          dismissedAlerts: [...state.dismissedAlerts, alertId],
        })),
      clearDismissedAlerts: () => set({ dismissedAlerts: [] }),

      // Page filter preferences
      servicesShowUpdatesOnly: false,
      setServicesShowUpdatesOnly: (value) => set({ servicesShowUpdatesOnly: value }),
      configFilesAttachedFilter: false,
      setConfigFilesAttachedFilter: (value) => set({ configFilesAttachedFilter: value }),
      configFilesServiceFilter: null,
      setConfigFilesServiceFilter: (serviceId) => set({ configFilesServiceFilter: serviceId }),
      activityResourceTypeFilter: '',
      setActivityResourceTypeFilter: (type) => set({ activityResourceTypeFilter: type }),
      monitoringHealthType: '',
      setMonitoringHealthType: (type) => set({ monitoringHealthType: type }),
      monitoringHealthStatus: '',
      setMonitoringHealthStatus: (status) => set({ monitoringHealthStatus: status }),
      monitoringHealthTab: 'status',
      setMonitoringHealthTab: (tab) => set({ monitoringHealthTab: tab }),
      monitoringDatabaseTypeTab: '',
      setMonitoringDatabaseTypeTab: (type) => set({ monitoringDatabaseTypeTab: type }),
    }),
    {
      name: 'app-storage',
      partialize: (state) => ({
        selectedEnvironment: state.selectedEnvironment,
        sidebarCollapsed: state.sidebarCollapsed,
        collapsedGroups: state.collapsedGroups,
        monitoringTimeRange: state.monitoringTimeRange,
        autoRefreshEnabled: state.autoRefreshEnabled,
        monitoringServerFilter: state.monitoringServerFilter,
        monitoringServiceFilter: state.monitoringServiceFilter,
        monitoringDatabaseFilter: state.monitoringDatabaseFilter,
        // Note: dismissedAlerts NOT persisted (session-only)
        servicesShowUpdatesOnly: state.servicesShowUpdatesOnly,
        configFilesAttachedFilter: state.configFilesAttachedFilter,
        configFilesServiceFilter: state.configFilesServiceFilter,
        activityResourceTypeFilter: state.activityResourceTypeFilter,
        monitoringHealthType: state.monitoringHealthType,
        monitoringHealthStatus: state.monitoringHealthStatus,
        monitoringHealthTab: state.monitoringHealthTab,
        monitoringDatabaseTypeTab: state.monitoringDatabaseTypeTab,
      }),
    }
  )
);
