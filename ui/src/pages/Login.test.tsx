import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';
import Login from './Login';

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock api
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    login: vi.fn(),
    register: vi.fn(),
    api: {
      setToken: vi.fn(),
      getToken: vi.fn(),
    },
  };
});

describe('Login', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it('should render login form', () => {
    renderWithProviders(<Login />);
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/•+/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('should render tagline', () => {
    renderWithProviders(<Login />);
    expect(screen.getByText('Dock. Run. Ship. Repeat.')).toBeInTheDocument();
  });

  it('should toggle between login and register mode', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Login />);

    // Initially in login mode
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();

    // Switch to register
    await user.click(screen.getByText(/Don't have an account/));
    expect(screen.getByRole('heading', { name: 'Create Account' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();

    // Switch back to login
    await user.click(screen.getByText(/Already have an account/));
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('should submit login form successfully', async () => {
    const user = userEvent.setup();
    const { login } = await import('../lib/api');
    (login as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: 'jwt-token',
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
    });

    renderWithProviders(<Login />);

    await user.type(screen.getByPlaceholderText('you@example.com'), 'admin@test.com');
    await user.type(screen.getByPlaceholderText(/•+/), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('admin@test.com', 'password123');
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('should display error on login failure', async () => {
    const user = userEvent.setup();
    const { login } = await import('../lib/api');
    (login as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Invalid credentials'));

    renderWithProviders(<Login />);

    await user.type(screen.getByPlaceholderText('you@example.com'), 'bad@test.com');
    await user.type(screen.getByPlaceholderText(/•+/), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  it('should show loading state during submission', async () => {
    const user = userEvent.setup();
    const { login } = await import('../lib/api');
    let resolveLogin: (value: unknown) => void;
    (login as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );

    renderWithProviders(<Login />);

    await user.type(screen.getByPlaceholderText('you@example.com'), 'admin@test.com');
    await user.type(screen.getByPlaceholderText(/•+/), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(screen.getByText('Loading...')).toBeInTheDocument();

    // Resolve the promise to clean up
    resolveLogin!({
      token: 'jwt',
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
    });
  });

  it('should submit register form', async () => {
    const user = userEvent.setup();
    const { register } = await import('../lib/api');
    (register as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: 'jwt-token',
      user: { id: 'u1', email: 'new@test.com', name: 'New User', role: 'viewer' },
    });

    renderWithProviders(<Login />);

    // Switch to register mode
    await user.click(screen.getByText(/Don't have an account/));

    await user.type(screen.getByPlaceholderText('Your name'), 'New User');
    await user.type(screen.getByPlaceholderText('you@example.com'), 'new@test.com');
    await user.type(screen.getByPlaceholderText(/•+/), 'password123');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => {
      expect(register).toHaveBeenCalledWith('new@test.com', 'password123', 'New User');
    });
  });
});
