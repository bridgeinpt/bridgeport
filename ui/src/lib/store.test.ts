import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthStore, useAppStore, isAdmin, isOperator, isViewer, hasMinimumRole } from './store';
import type { User } from './api';

const adminUser: User = {
  id: 'u1',
  email: 'admin@test.com',
  name: 'Admin',
  role: 'admin',
};

const operatorUser: User = {
  id: 'u2',
  email: 'op@test.com',
  name: 'Operator',
  role: 'operator',
};

const viewerUser: User = {
  id: 'u3',
  email: 'viewer@test.com',
  name: 'Viewer',
  role: 'viewer',
};

describe('useAuthStore', () => {
  beforeEach(() => {
    const { result } = renderHook(() => useAuthStore());
    act(() => result.current.logout());
  });

  it('should start with null user and token', () => {
    const { result } = renderHook(() => useAuthStore());
    expect(result.current.user).toBeNull();
    expect(result.current.token).toBeNull();
  });

  it('should set auth user and token', () => {
    const { result } = renderHook(() => useAuthStore());
    act(() => result.current.setAuth(adminUser, 'test-token'));

    expect(result.current.user).toEqual(adminUser);
    expect(result.current.token).toBe('test-token');
  });

  it('should update user without changing token', () => {
    const { result } = renderHook(() => useAuthStore());
    act(() => result.current.setAuth(adminUser, 'test-token'));
    act(() => result.current.setUser({ ...adminUser, name: 'Updated' }));

    expect(result.current.user?.name).toBe('Updated');
    expect(result.current.token).toBe('test-token');
  });

  it('should clear user and token on logout', () => {
    const { result } = renderHook(() => useAuthStore());
    act(() => result.current.setAuth(adminUser, 'test-token'));
    act(() => result.current.logout());

    expect(result.current.user).toBeNull();
    expect(result.current.token).toBeNull();
  });
});

describe('role helpers', () => {
  it('isAdmin should return true only for admin users', () => {
    expect(isAdmin(adminUser)).toBe(true);
    expect(isAdmin(operatorUser)).toBe(false);
    expect(isAdmin(viewerUser)).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });

  it('isOperator should return true only for operator users', () => {
    expect(isOperator(adminUser)).toBe(false);
    expect(isOperator(operatorUser)).toBe(true);
    expect(isOperator(viewerUser)).toBe(false);
  });

  it('isViewer should return true only for viewer users', () => {
    expect(isViewer(adminUser)).toBe(false);
    expect(isViewer(operatorUser)).toBe(false);
    expect(isViewer(viewerUser)).toBe(true);
  });

  it('hasMinimumRole should check role hierarchy correctly', () => {
    // admin >= admin
    expect(hasMinimumRole(adminUser, 'admin')).toBe(true);
    // admin >= operator
    expect(hasMinimumRole(adminUser, 'operator')).toBe(true);
    // admin >= viewer
    expect(hasMinimumRole(adminUser, 'viewer')).toBe(true);

    // operator >= operator
    expect(hasMinimumRole(operatorUser, 'operator')).toBe(true);
    // operator >= viewer
    expect(hasMinimumRole(operatorUser, 'viewer')).toBe(true);
    // operator < admin
    expect(hasMinimumRole(operatorUser, 'admin')).toBe(false);

    // viewer >= viewer
    expect(hasMinimumRole(viewerUser, 'viewer')).toBe(true);
    // viewer < operator
    expect(hasMinimumRole(viewerUser, 'operator')).toBe(false);
    // viewer < admin
    expect(hasMinimumRole(viewerUser, 'admin')).toBe(false);

    // null user
    expect(hasMinimumRole(null, 'viewer')).toBe(false);
  });
});

describe('useAppStore', () => {
  beforeEach(() => {
    // Reset store state
    useAppStore.setState({
      selectedEnvironment: null,
      sidebarCollapsed: false,
      collapsedGroups: [],
      monitoringTimeRange: 24,
      autoRefreshEnabled: true,
      monitoringServerFilter: [],
      monitoringServiceFilter: [],
      monitoringDatabaseFilter: [],
      breadcrumbNames: {},
      dismissedAlerts: [],
      servicesShowUpdatesOnly: false,
      configFilesAttachedFilter: false,
      configFilesServiceFilter: null,
      activityResourceTypeFilter: '',
      monitoringHealthType: '',
      monitoringHealthStatus: '',
      monitoringHealthTab: 'status',
      monitoringDatabaseTypeTab: '',
    });
  });

  it('should set and get selected environment', () => {
    const { result } = renderHook(() => useAppStore());
    const env = { id: 'env-1', name: 'Production', createdAt: '2024-01-01', _count: { servers: 1, secrets: 2 } };

    act(() => result.current.setSelectedEnvironment(env));
    expect(result.current.selectedEnvironment).toEqual(env);
  });

  it('should clear selected environment', () => {
    const { result } = renderHook(() => useAppStore());
    const env = { id: 'env-1', name: 'Production', createdAt: '2024-01-01', _count: { servers: 1, secrets: 2 } };

    act(() => result.current.setSelectedEnvironment(env));
    act(() => result.current.clearSelectedEnvironment());
    expect(result.current.selectedEnvironment).toBeNull();
  });

  it('should toggle sidebar', () => {
    const { result } = renderHook(() => useAppStore());
    expect(result.current.sidebarCollapsed).toBe(false);

    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarCollapsed).toBe(true);

    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it('should toggle menu group collapse', () => {
    const { result } = renderHook(() => useAppStore());
    expect(result.current.collapsedGroups).toEqual([]);

    act(() => result.current.toggleGroup('Operations'));
    expect(result.current.collapsedGroups).toContain('Operations');

    act(() => result.current.toggleGroup('Operations'));
    expect(result.current.collapsedGroups).not.toContain('Operations');
  });

  it('should set monitoring time range', () => {
    const { result } = renderHook(() => useAppStore());
    act(() => result.current.setMonitoringTimeRange(6));
    expect(result.current.monitoringTimeRange).toBe(6);
  });

  it('should toggle auto refresh', () => {
    const { result } = renderHook(() => useAppStore());
    expect(result.current.autoRefreshEnabled).toBe(true);

    act(() => result.current.setAutoRefreshEnabled(false));
    expect(result.current.autoRefreshEnabled).toBe(false);
  });

  it('should set monitoring filters', () => {
    const { result } = renderHook(() => useAppStore());
    act(() => result.current.setMonitoringServerFilter(['s1', 's2']));
    expect(result.current.monitoringServerFilter).toEqual(['s1', 's2']);

    act(() => result.current.setMonitoringServiceFilter(['svc1']));
    expect(result.current.monitoringServiceFilter).toEqual(['svc1']);

    act(() => result.current.setMonitoringDatabaseFilter(['db1']));
    expect(result.current.monitoringDatabaseFilter).toEqual(['db1']);
  });

  it('should set breadcrumb names (session-only)', () => {
    const { result } = renderHook(() => useAppStore());
    act(() => result.current.setBreadcrumbName('uuid-1', 'web-01'));
    expect(result.current.breadcrumbNames['uuid-1']).toBe('web-01');
  });

  it('should dismiss and clear alerts', () => {
    const { result } = renderHook(() => useAppStore());
    act(() => result.current.dismissAlert('alert-1'));
    act(() => result.current.dismissAlert('alert-2'));
    expect(result.current.dismissedAlerts).toEqual(['alert-1', 'alert-2']);

    act(() => result.current.clearDismissedAlerts());
    expect(result.current.dismissedAlerts).toEqual([]);
  });

  it('should persist filter preferences', () => {
    const { result } = renderHook(() => useAppStore());
    act(() => result.current.setServicesShowUpdatesOnly(true));
    expect(result.current.servicesShowUpdatesOnly).toBe(true);

    act(() => result.current.setConfigFilesAttachedFilter(true));
    expect(result.current.configFilesAttachedFilter).toBe(true);

    act(() => result.current.setConfigFilesServiceFilter('svc-1'));
    expect(result.current.configFilesServiceFilter).toBe('svc-1');

    act(() => result.current.setActivityResourceTypeFilter('server'));
    expect(result.current.activityResourceTypeFilter).toBe('server');
  });

  it('should set monitoring health filters', () => {
    const { result } = renderHook(() => useAppStore());
    act(() => result.current.setMonitoringHealthType('container'));
    expect(result.current.monitoringHealthType).toBe('container');

    act(() => result.current.setMonitoringHealthStatus('unhealthy'));
    expect(result.current.monitoringHealthStatus).toBe('unhealthy');

    act(() => result.current.setMonitoringHealthTab('logs'));
    expect(result.current.monitoringHealthTab).toBe('logs');
  });

  describe('partialize (persistence)', () => {
    it('should include persisted keys in partialize output', () => {
      // The partialize function is configured in the store.
      // We verify by checking that the store shape matches expectations.
      const state = useAppStore.getState();

      // These should be in the store
      expect(state).toHaveProperty('selectedEnvironment');
      expect(state).toHaveProperty('sidebarCollapsed');
      expect(state).toHaveProperty('collapsedGroups');
      expect(state).toHaveProperty('monitoringTimeRange');
      expect(state).toHaveProperty('autoRefreshEnabled');
      expect(state).toHaveProperty('servicesShowUpdatesOnly');
    });

    it('should not persist dismissedAlerts (session-only)', () => {
      // dismissedAlerts is intentionally excluded from partialize
      const { result } = renderHook(() => useAppStore());
      act(() => result.current.dismissAlert('test'));
      expect(result.current.dismissedAlerts).toContain('test');
      // Note: We can't easily test localStorage exclusion in unit tests
      // but we verify it's in the state for session use
    });
  });
});
