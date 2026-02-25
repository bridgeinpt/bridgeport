package collector

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCheckTCPPorts(t *testing.T) {
	// Start a local TCP server for testing
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port

	// Accept connections in the background
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()

	tests := []struct {
		name    string
		targets []TCPCheckConfig
		wantLen int
	}{
		{
			name: "reachable port",
			targets: []TCPCheckConfig{
				{Host: "127.0.0.1", Port: port, Name: "test-server"},
			},
			wantLen: 1,
		},
		{
			name: "unreachable port",
			targets: []TCPCheckConfig{
				{Host: "127.0.0.1", Port: 1, Name: "closed-port"},
			},
			wantLen: 1,
		},
		{
			name:    "empty targets",
			targets: []TCPCheckConfig{},
			wantLen: 0,
		},
		{
			name: "multiple targets",
			targets: []TCPCheckConfig{
				{Host: "127.0.0.1", Port: port, Name: "open"},
				{Host: "127.0.0.1", Port: 1, Name: "closed"},
			},
			wantLen: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			results := CheckTCPPorts(tt.targets, 2*time.Second)
			assert.Len(t, results, tt.wantLen)

			if tt.name == "reachable port" && len(results) > 0 {
				assert.True(t, results[0].Success)
				assert.Equal(t, "127.0.0.1", results[0].Host)
				assert.Equal(t, port, results[0].Port)
				assert.Equal(t, "test-server", results[0].Name)
				assert.Empty(t, results[0].Error)
				assert.GreaterOrEqual(t, results[0].DurationMs, 0)
			}

			if tt.name == "unreachable port" && len(results) > 0 {
				assert.False(t, results[0].Success)
				assert.NotEmpty(t, results[0].Error)
			}
		})
	}
}

func TestCheckTCPPortsDefaultTimeout(t *testing.T) {
	// Verify default timeout is applied when 0 is passed
	results := CheckTCPPorts([]TCPCheckConfig{
		{Host: "192.0.2.1", Port: 12345, Name: "unreachable"},
	}, 0)

	// Should still produce a result (with failure due to timeout)
	assert.Len(t, results, 1)
	assert.False(t, results[0].Success)
}

func TestCheckCertificates(t *testing.T) {
	// Start a TLS test server
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	// Extract host and port from test server URL
	host, portStr, err := net.SplitHostPort(ts.Listener.Addr().String())
	require.NoError(t, err)

	var port int
	_, err = net.LookupPort("tcp", portStr)
	if err != nil {
		// Manually parse
		for _, c := range portStr {
			port = port*10 + int(c-'0')
		}
	} else {
		for _, c := range portStr {
			port = port*10 + int(c-'0')
		}
	}

	tests := []struct {
		name    string
		targets []CertCheckConfig
		wantLen int
	}{
		{
			name: "valid TLS server",
			targets: []CertCheckConfig{
				{Host: host, Port: port, Name: "test-tls"},
			},
			wantLen: 1,
		},
		{
			name:    "empty targets",
			targets: []CertCheckConfig{},
			wantLen: 0,
		},
		{
			name: "unreachable TLS server",
			targets: []CertCheckConfig{
				{Host: "192.0.2.1", Port: 443, Name: "unreachable"},
			},
			wantLen: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			timeout := 2 * time.Second
			if tt.name == "unreachable TLS server" {
				timeout = 500 * time.Millisecond
			}

			results := CheckCertificates(tt.targets, timeout)
			assert.Len(t, results, tt.wantLen)

			if tt.name == "valid TLS server" && len(results) > 0 {
				assert.True(t, results[0].Success)
				assert.Equal(t, host, results[0].Host)
				assert.Equal(t, "test-tls", results[0].Name)
				assert.NotEmpty(t, results[0].ExpiresAt)
				assert.GreaterOrEqual(t, results[0].DurationMs, 0)
			}

			if tt.name == "unreachable TLS server" && len(results) > 0 {
				assert.False(t, results[0].Success)
				assert.NotEmpty(t, results[0].Error)
			}
		})
	}
}

func TestGetContainerHealthStatus(t *testing.T) {
	tests := []struct {
		name       string
		container  string
		healthData map[string]interface{}
		wantStatus string
		wantStreak int
	}{
		{
			name:      "healthy container",
			container: "web-app",
			healthData: map[string]interface{}{
				"Status":        "healthy",
				"FailingStreak": float64(0),
			},
			wantStatus: "healthy",
			wantStreak: 0,
		},
		{
			name:      "unhealthy with failing streak",
			container: "api-server",
			healthData: map[string]interface{}{
				"Status":        "unhealthy",
				"FailingStreak": float64(5),
			},
			wantStatus: "unhealthy",
			wantStreak: 5,
		},
		{
			name:       "nil health data",
			container:  "worker",
			healthData: nil,
			wantStatus: "none",
			wantStreak: 0,
		},
		{
			name:       "empty health data",
			container:  "cron",
			healthData: map[string]interface{}{},
			wantStatus: "none",
			wantStreak: 0,
		},
		{
			name:      "with log output",
			container: "db",
			healthData: map[string]interface{}{
				"Status":        "healthy",
				"FailingStreak": float64(0),
				"Log": []interface{}{
					map[string]interface{}{
						"Output": "OK",
					},
				},
			},
			wantStatus: "healthy",
			wantStreak: 0,
		},
		{
			name:      "with long log output truncation",
			container: "service",
			healthData: map[string]interface{}{
				"Status":        "unhealthy",
				"FailingStreak": float64(3),
				"Log": []interface{}{
					map[string]interface{}{
						"Output": string(make([]byte, 300)), // 300 bytes, should be truncated to 200
					},
				},
			},
			wantStatus: "unhealthy",
			wantStreak: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := GetContainerHealthStatus(tt.container, tt.healthData)

			assert.Equal(t, tt.container, result.ContainerName)
			assert.Equal(t, tt.wantStatus, result.Status)
			assert.Equal(t, tt.wantStreak, result.FailingStreak)

			if tt.name == "with long log output truncation" && result.Log != "" {
				assert.LessOrEqual(t, len(result.Log), 203) // 200 + "..."
			}
		})
	}
}

func TestTCPCheckResultFields(t *testing.T) {
	result := TCPCheckResult{
		Host:       "example.com",
		Port:       443,
		Name:       "https",
		Success:    true,
		DurationMs: 50,
		Error:      "",
	}

	assert.Equal(t, "example.com", result.Host)
	assert.Equal(t, 443, result.Port)
	assert.Equal(t, "https", result.Name)
	assert.True(t, result.Success)
	assert.Equal(t, 50, result.DurationMs)
	assert.Empty(t, result.Error)
}

func TestCertCheckResultFields(t *testing.T) {
	result := CertCheckResult{
		Host:            "example.com",
		Port:            443,
		Name:            "https",
		Success:         true,
		DurationMs:      100,
		ExpiresAt:       "2025-12-31T23:59:59Z",
		DaysUntilExpiry: 365,
		Issuer:          "Let's Encrypt",
		Subject:         "example.com",
		Error:           "",
	}

	assert.Equal(t, "example.com", result.Host)
	assert.Equal(t, 443, result.Port)
	assert.True(t, result.Success)
	assert.Equal(t, "2025-12-31T23:59:59Z", result.ExpiresAt)
	assert.Equal(t, 365, result.DaysUntilExpiry)
	assert.Equal(t, "Let's Encrypt", result.Issuer)
	assert.Equal(t, "example.com", result.Subject)
}
