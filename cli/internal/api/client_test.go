package api

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
				{ID: "svc-1", Name: "app", Status: "running", Health: "healthy"},
				{ID: "svc-2", Name: "worker", Status: "running", Health: "none"},
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
