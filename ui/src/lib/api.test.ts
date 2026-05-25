import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { api, getServiceLogs } from './api';

// Mock sentry to avoid import issues
vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

// We test the ApiClient by mocking fetch directly, since the api client
// uses relative URLs (/api/...) which don't work with MSW in node mode.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  api.setToken(null);
  api.clearCache();
  // Reset localStorage
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as Response);
}

describe('ApiClient', () => {
  describe('token management', () => {
    it('should store token in localStorage when set', () => {
      api.setToken('my-token');
      expect(localStorage.getItem('auth_token')).toBe('my-token');
    });

    it('should remove token from localStorage when set to null', () => {
      api.setToken('my-token');
      api.setToken(null);
      expect(localStorage.getItem('auth_token')).toBeNull();
    });

    it('should read token from localStorage if not in memory', () => {
      localStorage.setItem('auth_token', 'stored-token');
      // Force re-read by setting internal token to null
      api.setToken(null);
      localStorage.setItem('auth_token', 'stored-token');
      expect(api.getToken()).toBe('stored-token');
    });
  });

  describe('request headers', () => {
    it('should attach Authorization header when token is set', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ok: true }));
      api.setToken('test-jwt');
      await api.get('/test');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer test-jwt');
    });

    it('should not attach Authorization header when no token', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ok: true }));
      await api.get('/test');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBeUndefined();
    });

    it('should set Content-Type to application/json', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ok: true }));
      await api.post('/test', { data: 'value' });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('request URL', () => {
    it('should prepend /api to the path', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ok: true }));
      await api.get('/servers');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/servers');
    });
  });

  describe('request body', () => {
    it('should JSON stringify the body for POST', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: '1' }));
      await api.post('/items', { name: 'test' });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.body).toBe(JSON.stringify({ name: 'test' }));
    });

    it('should not include body for GET', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ items: [] }));
      await api.get('/items');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.body).toBeUndefined();
    });
  });

  describe('401 handling', () => {
    it('should clear token and redirect to /login on 401', async () => {
      api.setToken('expired-token');
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));

      // Mock window.location
      const originalLocation = window.location;
      delete (window as Record<string, unknown>).location;
      window.location = { href: '' } as Location;

      await expect(api.get('/protected')).rejects.toThrow('Unauthorized');

      expect(window.location.href).toBe('/login');
      expect(localStorage.getItem('auth_token')).toBeNull();

      // Restore
      window.location = originalLocation;
    });
  });

  describe('error handling', () => {
    it('should throw error with message from API response', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Validation failed' }, 400));
      await expect(api.post('/fail', {})).rejects.toThrow('Validation failed');
    });

    it('should throw generic error when no error message in response', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}, 500));
      await expect(api.get('/fail')).rejects.toThrow('Request failed');
    });

    it('should report 5xx errors to sentry', async () => {
      const { captureException } = await import('./sentry');
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Internal error' }, 500));
      await expect(api.get('/fail')).rejects.toThrow();
      expect(captureException).toHaveBeenCalled();
    });
  });

  describe('HTTP methods', () => {
    it('should send GET requests', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ items: [] }));
      const result = await api.get<{ items: unknown[] }>('/items');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('GET');
      expect(result.items).toEqual([]);
    });

    it('should send POST requests', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: '1' }));
      await api.post('/items', { name: 'test' });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
    });

    it('should send PATCH requests', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: '1' }));
      await api.patch('/items/1', { name: 'updated' });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('PATCH');
    });

    it('should send PUT requests', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: '1' }));
      await api.put('/items/1', { name: 'replaced' });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('PUT');
    });

    it('should send DELETE requests', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ success: true }));
      await api.delete('/items/1');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('DELETE');
    });
  });

  describe('caching', () => {
    it('should return cached data within TTL', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ count: 1 }));
      const first = await api.getCached<{ count: number }>('/cached', 60000);
      const second = await api.getCached<{ count: number }>('/cached', 60000);

      expect(first.count).toBe(1);
      expect(second.count).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should clear cache by pattern', async () => {
      mockFetch
        .mockReturnValueOnce(jsonResponse({ count: 1 }))
        .mockReturnValueOnce(jsonResponse({ count: 2 }));

      await api.getCached('/cached', 60000);
      api.clearCache('cached');
      const result = await api.getCached<{ count: number }>('/cached', 60000);

      expect(result.count).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache', async () => {
      mockFetch
        .mockReturnValueOnce(jsonResponse({ count: 1 }))
        .mockReturnValueOnce(jsonResponse({ count: 2 }));

      await api.getCached('/data', 60000);
      api.clearCache();
      const result = await api.getCached<{ count: number }>('/data', 60000);

      expect(result.count).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('request deduplication', () => {
    it('should deduplicate concurrent GET requests to same path', async () => {
      mockFetch.mockReturnValue(jsonResponse({ ok: true }));

      const [r1, r2] = await Promise.all([
        api.get('/dedup'),
        api.get('/dedup'),
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(r2);
    });
  });
});

describe('getServiceLogs', () => {
  it('hits the logs endpoint without query string when no options are given', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ logs: 'output' }));
    await getServiceLogs('svc-1');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/services/svc-1/logs');
  });

  it('hits the logs endpoint without query string when options are empty', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ logs: 'output' }));
    await getServiceLogs('svc-1', {});

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/services/svc-1/logs');
  });

  it('includes tail in the query string when provided', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ logs: '' }));
    await getServiceLogs('svc-1', { tail: 200 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/services/svc-1/logs?tail=200');
  });

  it('includes before in the query string when provided', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ logs: '' }));
    await getServiceLogs('svc-1', { before: '2026-05-20T10:00:00Z' });

    const [url] = mockFetch.mock.calls[0];
    // URLSearchParams URL-encodes the colon characters.
    expect(url).toBe('/api/services/svc-1/logs?before=2026-05-20T10%3A00%3A00Z');
  });

  it('includes both tail and before when both are provided', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ logs: '' }));
    await getServiceLogs('svc-1', { tail: 50, before: '2026-05-20T10:00:00Z' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/services/svc-1/logs?tail=50&before=2026-05-20T10%3A00%3A00Z');
  });

  it('does not send tail=0 as a query param (treats 0 as falsy)', async () => {
    // Documents current behavior: getServiceLogs uses `if (opts?.tail)`, so 0 is dropped.
    mockFetch.mockReturnValueOnce(jsonResponse({ logs: '' }));
    await getServiceLogs('svc-1', { tail: 0 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/services/svc-1/logs');
  });
});
