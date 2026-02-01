import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Environment } from './api';

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      logout: () => set({ user: null, token: null }),
    }),
    {
      name: 'auth-storage',
    }
  )
);

interface AppState {
  selectedEnvironment: Environment | null;
  setSelectedEnvironment: (env: Environment | null) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedEnvironment: null,
  setSelectedEnvironment: (env) => set({ selectedEnvironment: env }),
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
