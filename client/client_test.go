package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewClient(t *testing.T) {
	client := NewClient("https://example.com", "test-token")

	assert.Equal(t, "https://example.com", client.BaseURL)
	assert.Equal(t, "test-token", client.Token)
	assert.NotNil(t, client.HTTPClient)
}

func TestClientGet(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "GET", r.Method)
		assert.Equal(t, "/api/test", r.URL.Path)
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))

		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	var result map[string]string
	err := client.Get("/api/test", &result)
	require.NoError(t, err)
	assert.Equal(t, "ok", result["status"])
}

func TestClientPost(t *testing.T) {
	var receivedBody map[string]string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		json.NewDecoder(r.Body).Decode(&receivedBody)
		json.NewEncoder(w).Encode(map[string]string{"id": "123"})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	body := map[string]string{"name": "test"}
	var result map[string]string
	err := client.Post("/api/test", body, &result)
	require.NoError(t, err)

	assert.Equal(t, "test", receivedBody["name"])
	assert.Equal(t, "123", result["id"])
}

func TestClientPatch(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "PATCH", r.Method)
		json.NewEncoder(w).Encode(map[string]string{"updated": "true"})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	var result map[string]string
	err := client.Patch("/api/test/1", map[string]string{"name": "updated"}, &result)
	require.NoError(t, err)
	assert.Equal(t, "true", result["updated"])
}

func TestClientDelete(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "DELETE", r.Method)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	err := client.Delete("/api/test/1", nil)
	assert.NoError(t, err)
}

func TestClientNoAuthHeader(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Authorization"), "should not set auth header when token is empty")
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "")
	err := client.Get("/api/test", nil)
	assert.NoError(t, err)
}

func TestClientAPIError(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		wantMsg    string
	}{
		{
			name:    "error field",
			status:  400,
			body:    `{"error": "Invalid input"}`,
			wantMsg: "Invalid input",
		},
		{
			name:    "message field",
			status:  404,
			body:    `{"message": "Not found"}`,
			wantMsg: "Not found",
		},
		{
			name:    "plain text body",
			status:  500,
			body:    `Internal Server Error`,
			wantMsg: "Internal Server Error",
		},
		{
			name:    "empty body",
			status:  502,
			body:    ``,
			wantMsg: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				w.Write([]byte(tt.body))
			}))
			defer ts.Close()

			client := NewClient(ts.URL, "test-token")
			err := client.Get("/api/test", nil)
			require.Error(t, err)

			apiErr, ok := err.(*APIError)
			require.True(t, ok, "error should be *APIError")
			assert.Equal(t, tt.status, apiErr.StatusCode)
			if tt.wantMsg != "" {
				assert.Contains(t, apiErr.Message, tt.wantMsg)
			}
		})
	}
}

func TestAPIErrorString(t *testing.T) {
	err := &APIError{StatusCode: 404, Message: "not found"}
	assert.Equal(t, "API error (404): not found", err.Error())
}

func TestClientLogin(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "/api/auth/login", r.URL.Path)

		var body LoginRequest
		json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "user@example.com", body.Email)
		assert.Equal(t, "password123", body.Password)

		json.NewEncoder(w).Encode(LoginResponse{
			Token: "jwt-token-123",
			User: struct {
				ID    string `json:"id"`
				Email string `json:"email"`
				Role  string `json:"role"`
			}{
				ID:    "user-1",
				Email: "user@example.com",
				Role:  "admin",
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "")

	resp, err := client.Login("user@example.com", "password123")
	require.NoError(t, err)
	assert.Equal(t, "jwt-token-123", resp.Token)
	assert.Equal(t, "user@example.com", resp.User.Email)
	assert.Equal(t, "admin", resp.User.Role)
}

func TestClientGetCurrentUser(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/auth/me", r.URL.Path)

		name := "Test User"
		json.NewEncoder(w).Encode(map[string]interface{}{
			"user": User{
				ID:    "user-1",
				Email: "user@example.com",
				Name:  &name,
				Role:  "admin",
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	user, err := client.GetCurrentUser()
	require.NoError(t, err)
	assert.Equal(t, "user-1", user.ID)
	assert.Equal(t, "user@example.com", user.Email)
	assert.Equal(t, "admin", user.Role)
}

func TestClientValidateToken(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"user": User{ID: "1", Email: "test@test.com", Role: "admin"},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "valid-token")
	assert.True(t, client.ValidateToken())
}

func TestClientValidateTokenInvalid(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": "unauthorized"}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "invalid-token")
	assert.False(t, client.ValidateToken())
}

func TestClientListEnvironments(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments", r.URL.Path)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"environments": []Environment{
				{ID: "env-1", Name: "staging"},
				{ID: "env-2", Name: "production"},
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")
	envs, err := client.ListEnvironments()
	require.NoError(t, err)
	assert.Len(t, envs, 2)
	assert.Equal(t, "staging", envs[0].Name)
	assert.Equal(t, "production", envs[1].Name)
}

func TestClientListServers(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/environments" {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"environments": []Environment{{ID: "env-1", Name: "staging"}},
			})
			return
		}
		if r.URL.Path == "/api/environments/env-1/servers" {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"servers": []Server{
					{ID: "srv-1", Name: "web-01", PrivateIP: "10.0.0.1", Status: "healthy"},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	// Test with environment filter
	servers, err := client.ListServers("env-1")
	require.NoError(t, err)
	assert.Len(t, servers, 1)
	assert.Equal(t, "web-01", servers[0].Name)
}

func TestClientGetServerByEnvAndName(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/environments":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"environments": []Environment{{ID: "env-1", Name: "staging"}},
			})
		case "/api/environments/env-1/servers":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"servers": []Server{
					{ID: "srv-1", Name: "web-01", PrivateIP: "10.0.0.1", EnvironmentID: "env-1"},
					{ID: "srv-2", Name: "db-01", PrivateIP: "10.0.0.2", EnvironmentID: "env-1"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	server, err := client.GetServerByEnvAndName("staging", "web-01")
	require.NoError(t, err)
	assert.Equal(t, "srv-1", server.ID)
	assert.Equal(t, "web-01", server.Name)
}

func TestClientGetServerByEnvAndNameNotFound(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/environments":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"environments": []Environment{{ID: "env-1", Name: "staging"}},
			})
		case "/api/environments/env-1/servers":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"servers": []Server{},
			})
		}
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	_, err := client.GetServerByEnvAndName("staging", "nonexistent")
	require.Error(t, err)

	apiErr, ok := err.(*APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.StatusCode)
	assert.Contains(t, apiErr.Message, "nonexistent")
}

func TestClientGetServerByEnvAndNameBadEnv(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"environments": []Environment{},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	_, err := client.GetServerByEnvAndName("nonexistent", "web-01")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nonexistent")
}

func TestClientListServices(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"services": []Service{
				{ID: "svc-1", Name: "app", Status: "running", HealthStatus: "healthy"},
				{ID: "svc-2", Name: "worker", Status: "running", HealthStatus: "none"},
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	services, err := client.ListServices("srv-1")
	require.NoError(t, err)
	assert.Len(t, services, 2)
	assert.Equal(t, "app", services[0].Name)
}

func TestClientGetServiceByName(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"services": []Service{
				{ID: "svc-1", Name: "app"},
				{ID: "svc-2", Name: "worker"},
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	svc, err := client.GetServiceByName("srv-1", "worker")
	require.NoError(t, err)
	assert.Equal(t, "svc-2", svc.ID)
	assert.Equal(t, "worker", svc.Name)
}

func TestClientGetServiceByNameNotFound(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"services": []Service{},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	_, err := client.GetServiceByName("srv-1", "nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nonexistent")
}

func TestClientGetRunCommand(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Contains(t, r.URL.Path, "/run-command")

		var body RunCommandRequest
		json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "shell", body.CommandName)

		json.NewEncoder(w).Encode(RunCommandResponse{
			Command: "python manage.py shell",
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	cmd, err := client.GetRunCommand("svc-1", "shell")
	require.NoError(t, err)
	assert.Equal(t, "python manage.py shell", cmd)
}

func TestClientGetSSHKey(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(SSHCredentials{
			PrivateKey: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
			Username:   "deploy",
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	creds, err := client.GetSSHKey("env-1")
	require.NoError(t, err)
	assert.Contains(t, creds.PrivateKey, "BEGIN RSA PRIVATE KEY")
	assert.Equal(t, "deploy", creds.Username)
}

func TestClientListDatabases(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"databases": []Database{
				{ID: "db-1", Name: "main-db", Type: "postgresql"},
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	dbs, err := client.ListDatabases("env-1")
	require.NoError(t, err)
	assert.Len(t, dbs, 1)
	assert.Equal(t, "main-db", dbs[0].Name)
}

func TestClientListAuditLogs(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.RawQuery, "limit=10")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"logs":  []AuditLog{{ID: "log-1", Action: "deploy", ResourceType: "service", Success: true}},
			"total": 1,
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	logs, total, err := client.ListAuditLogs(map[string]string{"limit": "10"})
	require.NoError(t, err)
	assert.Len(t, logs, 1)
	assert.Equal(t, 1, total)
	assert.Equal(t, "deploy", logs[0].Action)
}

// The single-resource detail endpoints wrap the payload under the resource
// name (e.g. {"server": {...}}). These tests guard against regressing to an
// unwrapped unmarshal, which silently returns a zero-value struct (issue #300).

func TestClientGetServerUnwrapsWrappedBody(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/servers/srv-1", r.URL.Path)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"server": Server{ID: "srv-1", Name: "web-01", PrivateIP: "10.0.0.1", EnvironmentID: "env-1"},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	server, err := client.GetServer("srv-1")
	require.NoError(t, err)
	assert.Equal(t, "srv-1", server.ID)
	assert.Equal(t, "web-01", server.Name)
	assert.Equal(t, "env-1", server.EnvironmentID)
}

func TestClientGetServiceUnwrapsWrappedBody(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/services/svc-1", r.URL.Path)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"service": Service{ID: "svc-1", Name: "api", ImageTag: "latest"},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	service, err := client.GetService("svc-1")
	require.NoError(t, err)
	assert.Equal(t, "svc-1", service.ID)
	assert.Equal(t, "api", service.Name)
	assert.Equal(t, "latest", service.ImageTag)
}

func TestClientGetEnvironmentUnwrapsWrappedBody(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1", r.URL.Path)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"environment": Environment{ID: "env-1", Name: "staging", DisplayName: "Staging"},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	env, err := client.GetEnvironment("env-1")
	require.NoError(t, err)
	assert.Equal(t, "env-1", env.ID)
	assert.Equal(t, "staging", env.Name)
	assert.Equal(t, "Staging", env.DisplayName)
}

// GET /api/servers/:id/metrics returns a time series under {"metrics": [...]}.
// Numeric fields are nullable (a collection mode may not report every metric),
// so they are pointers and must round-trip null as nil (issue #300).
func TestClientGetServerMetricsReturnsSeries(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/servers/srv-1/metrics", r.URL.Path)
		w.Write([]byte(`{"metrics":[
			{"id":"m1","cpuPercent":12.5,"memoryUsedMb":2048,"uptime":3600,"tcpEstablished":null,"source":"agent","collectedAt":"2026-01-01T00:00:00Z"},
			{"id":"m2","cpuPercent":null,"source":"ssh","collectedAt":"2026-01-01T00:01:00Z"}
		]}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	metrics, err := client.GetServerMetrics("srv-1")
	require.NoError(t, err)
	require.Len(t, metrics, 2)

	assert.Equal(t, "m1", metrics[0].ID)
	require.NotNil(t, metrics[0].CPUPercent)
	assert.Equal(t, 12.5, *metrics[0].CPUPercent)
	require.NotNil(t, metrics[0].Uptime)
	assert.Equal(t, int64(3600), *metrics[0].Uptime)
	assert.Nil(t, metrics[0].TCPEstablished) // explicit null stays nil
	assert.Equal(t, "agent", metrics[0].Source)

	assert.Nil(t, metrics[1].CPUPercent) // explicit null stays nil
	assert.Equal(t, "ssh", metrics[1].Source)
}

// ListRegistries must map every field the API returns, not the subset it used
// to copy, and fold _count.containerImages into ImageCount (issue #301).
func TestClientListRegistriesMapsAllFields(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1/registries", r.URL.Path)
		w.Write([]byte(`{"registries":[{
			"id":"reg-1","name":"dockerhub","type":"dockerhub","registryUrl":"https://index.docker.io",
			"repositoryPrefix":"myorg","username":"bot","hasToken":true,"hasPassword":false,
			"isDefault":true,"refreshIntervalMinutes":60,"autoLinkPattern":"app-*",
			"lastRefreshAt":"2026-01-01T00:00:00Z","createdAt":"2025-01-01T00:00:00Z",
			"updatedAt":"2026-01-02T00:00:00Z","environmentId":"env-1",
			"_count":{"containerImages":7}
		}]}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	regs, err := client.ListRegistries("env-1")
	require.NoError(t, err)
	require.Len(t, regs, 1)

	r := regs[0]
	assert.Equal(t, "reg-1", r.ID)
	assert.Equal(t, "dockerhub", r.Name)
	// Fields previously dropped by ListRegistries:
	require.NotNil(t, r.Username)
	assert.Equal(t, "bot", *r.Username)
	require.NotNil(t, r.RepositoryPrefix)
	assert.Equal(t, "myorg", *r.RepositoryPrefix)
	require.NotNil(t, r.AutoLinkPattern)
	assert.Equal(t, "app-*", *r.AutoLinkPattern)
	assert.Equal(t, 60, r.RefreshIntervalMinutes)
	assert.True(t, r.HasToken)
	assert.False(t, r.HasPassword)
	assert.Equal(t, "2026-01-02T00:00:00Z", r.UpdatedAt)
	require.NotNil(t, r.LastRefreshAt)
	assert.Equal(t, "2026-01-01T00:00:00Z", *r.LastRefreshAt)
	// imageCount is derived from _count.containerImages:
	assert.Equal(t, 7, r.ImageCount)
}

// GetRegistry unwraps {"registry": {...}} and folds _count into ImageCount.
func TestClientGetRegistry(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/registries/reg-1", r.URL.Path)
		w.Write([]byte(`{"registry":{
			"id":"reg-1","name":"dockerhub","type":"dockerhub","registryUrl":"https://index.docker.io",
			"username":"bot","hasToken":true,"isDefault":false,"refreshIntervalMinutes":30,
			"environmentId":"env-1","createdAt":"2025-01-01T00:00:00Z","_count":{"containerImages":3}
		}}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "test-token")

	reg, err := client.GetRegistry("reg-1")
	require.NoError(t, err)
	assert.Equal(t, "reg-1", reg.ID)
	assert.Equal(t, "dockerhub", reg.Name)
	require.NotNil(t, reg.Username)
	assert.Equal(t, "bot", *reg.Username)
	assert.True(t, reg.HasToken)
	assert.Equal(t, 30, reg.RefreshIntervalMinutes)
	assert.Equal(t, 3, reg.ImageCount)
}
