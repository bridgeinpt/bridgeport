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
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedEnvironment: null,
      setSelectedEnvironment: (env) => set({ selectedEnvironment: env }),
      clearSelectedEnvironment: () => set({ selectedEnvironment: null }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    {
      name: 'app-storage',
      partialize: (state) => ({
        selectedEnvironment: state.selectedEnvironment,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);
