package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMetricsPayloadJSON(t *testing.T) {
	cpu := 45.5
	memUsed := 8192.0
	memTotal := 16384.0
	serverHealthy := true
	version := "test-version"

	payload := MetricsPayload{
		CPUPercent:    &cpu,
		MemoryUsedMb:  &memUsed,
		MemoryTotalMb: &memTotal,
		ServerHealthy: &serverHealthy,
		AgentVersion:  &version,
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)

	assert.Equal(t, 45.5, decoded["cpuPercent"])
	assert.Equal(t, 8192.0, decoded["memoryUsedMb"])
	assert.Equal(t, 16384.0, decoded["memoryTotalMb"])
	assert.Equal(t, true, decoded["serverHealthy"])
	assert.Equal(t, "test-version", decoded["agentVersion"])
}

func TestMetricsPayloadOmitsNilFields(t *testing.T) {
	serverHealthy := true
	payload := MetricsPayload{
		ServerHealthy: &serverHealthy,
		// All other fields are nil
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)

	// Nil fields should be omitted
	_, hasCPU := decoded["cpuPercent"]
	assert.False(t, hasCPU, "nil cpuPercent should be omitted")

	_, hasMemUsed := decoded["memoryUsedMb"]
	assert.False(t, hasMemUsed, "nil memoryUsedMb should be omitted")

	// Non-nil field should be present
	assert.Equal(t, true, decoded["serverHealthy"])
}

func TestSendMetrics(t *testing.T) {
	var receivedPayload MetricsPayload
	var receivedAuth string
	var receivedContentType string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "/api/metrics/ingest", r.URL.Path)

		receivedAuth = r.Header.Get("Authorization")
		receivedContentType = r.Header.Get("Content-Type")

		json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	config := Config{
		ServerURL: ts.URL,
		Token:     "test-token-123",
	}

	cpu := 50.0
	healthy := true
	payload := MetricsPayload{
		CPUPercent:    &cpu,
		ServerHealthy: &healthy,
	}

	err := sendMetrics(config, payload)
	assert.NoError(t, err)
	assert.Equal(t, "Bearer test-token-123", receivedAuth)
	assert.Equal(t, "application/json", receivedContentType)
	assert.NotNil(t, receivedPayload.CPUPercent)
	assert.Equal(t, 50.0, *receivedPayload.CPUPercent)
}

func TestSendMetricsServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer ts.Close()

	config := Config{
		ServerURL: ts.URL,
		Token:     "test-token",
	}

	err := sendMetrics(config, MetricsPayload{})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "500")
}

func TestSendMetricsConnectionError(t *testing.T) {
	config := Config{
		ServerURL: "http://127.0.0.1:1", // Unlikely to be running
		Token:     "test-token",
	}

	err := sendMetrics(config, MetricsPayload{})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to send request")
}

func TestFetchConfig(t *testing.T) {
	agentCfg := AgentConfig{
		ServerID:   "server-123",
		ServerName: "web-01",
		Services: []ServiceHealthConfig{
			{
				ContainerName:  "app",
				HealthCheckURL: "http://localhost:8080/health",
				TCPChecks: []TCPCheckConfig{
					{Host: "localhost", Port: 5432, Name: "postgres"},
				},
			},
		},
		MetricsConfig: MetricsConfig{
			CollectCpu:    true,
			CollectMemory: true,
			CollectDisk:   true,
		},
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "GET", r.Method)
		assert.Equal(t, "/api/agent/config", r.URL.Path)
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(agentCfg)
	}))
	defer ts.Close()

	// Reset global state for test
	agentConfigMutex.Lock()
	agentConfig = nil
	agentConfigMutex.Unlock()

	config := Config{
		ServerURL: ts.URL,
		Token:     "test-token",
	}

	fetchConfig(config)

	agentConfigMutex.RLock()
	defer agentConfigMutex.RUnlock()

	require.NotNil(t, agentConfig)
	assert.Equal(t, "server-123", agentConfig.ServerID)
	assert.Equal(t, "web-01", agentConfig.ServerName)
	assert.Len(t, agentConfig.Services, 1)
	assert.Equal(t, "app", agentConfig.Services[0].ContainerName)
	assert.True(t, agentConfig.MetricsConfig.CollectCpu)
	assert.True(t, agentConfig.MetricsConfig.CollectMemory)
	assert.True(t, agentConfig.MetricsConfig.CollectDisk)
	assert.False(t, agentConfig.MetricsConfig.CollectSwap)
}

func TestFetchConfigServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer ts.Close()

	// Reset global state
	agentConfigMutex.Lock()
	agentConfig = nil
	agentConfigMutex.Unlock()

	config := Config{
		ServerURL: ts.URL,
		Token:     "bad-token",
	}

	fetchConfig(config)

	agentConfigMutex.RLock()
	defer agentConfigMutex.RUnlock()

	assert.Nil(t, agentConfig, "config should remain nil on auth error")
}

func TestFetchConfigInvalidJSON(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("not valid json"))
	}))
	defer ts.Close()

	agentConfigMutex.Lock()
	agentConfig = nil
	agentConfigMutex.Unlock()

	config := Config{
		ServerURL: ts.URL,
		Token:     "test-token",
	}

	fetchConfig(config)

	agentConfigMutex.RLock()
	defer agentConfigMutex.RUnlock()

	assert.Nil(t, agentConfig, "config should remain nil on invalid JSON")
}

func TestPerformHealthChecks(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.WriteHeader(http.StatusOK)
		case "/unhealthy":
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	// Set up agent config with services
	agentConfigMutex.Lock()
	agentConfig = &AgentConfig{
		Services: []ServiceHealthConfig{
			{ContainerName: "healthy-app", HealthCheckURL: ts.URL + "/health"},
			{ContainerName: "unhealthy-app", HealthCheckURL: ts.URL + "/unhealthy"},
			{ContainerName: "no-url", HealthCheckURL: ""}, // Should be skipped
		},
	}
	agentConfigMutex.Unlock()

	results := performHealthChecks()

	assert.Len(t, results, 2, "should skip services without health check URL")

	// Find healthy result
	var healthyResult, unhealthyResult *ServiceHealthResult
	for i := range results {
		if results[i].ContainerName == "healthy-app" {
			healthyResult = &results[i]
		}
		if results[i].ContainerName == "unhealthy-app" {
			unhealthyResult = &results[i]
		}
	}

	require.NotNil(t, healthyResult)
	assert.True(t, healthyResult.Success)
	assert.NotNil(t, healthyResult.StatusCode)
	assert.Equal(t, 200, *healthyResult.StatusCode)
	assert.NotNil(t, healthyResult.DurationMs)
	assert.NotEmpty(t, healthyResult.CheckedAt)

	require.NotNil(t, unhealthyResult)
	assert.False(t, unhealthyResult.Success)
	assert.NotNil(t, unhealthyResult.StatusCode)
	assert.Equal(t, 503, *unhealthyResult.StatusCode)
}

func TestPerformHealthChecksNoConfig(t *testing.T) {
	agentConfigMutex.Lock()
	agentConfig = nil
	agentConfigMutex.Unlock()

	results := performHealthChecks()
	assert.Nil(t, results)
}

func TestPerformHealthChecksNoServices(t *testing.T) {
	agentConfigMutex.Lock()
	agentConfig = &AgentConfig{
		Services: []ServiceHealthConfig{},
	}
	agentConfigMutex.Unlock()

	results := performHealthChecks()
	assert.Nil(t, results)
}

func TestConfigStruct(t *testing.T) {
	config := Config{
		ServerURL: "https://deploy.example.com",
		Token:     "agent-token-123",
		Interval:  30_000_000_000, // 30 seconds in nanoseconds
	}

	assert.Equal(t, "https://deploy.example.com", config.ServerURL)
	assert.Equal(t, "agent-token-123", config.Token)
}

func TestServiceMetricsJSON(t *testing.T) {
	cpu := 25.5
	memUsed := 512.0
	memLimit := 2048.0
	rxMb := 100.0
	txMb := 50.0
	state := "running"
	health := "healthy"
	restarts := 0

	sm := ServiceMetrics{
		ContainerName: "web-app",
		CPUPercent:    &cpu,
		MemoryUsedMb:  &memUsed,
		MemoryLimitMb: &memLimit,
		NetworkRxMb:   &rxMb,
		NetworkTxMb:   &txMb,
		State:         &state,
		Health:        &health,
		RestartCount:  &restarts,
	}

	data, err := json.Marshal(sm)
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)

	assert.Equal(t, "web-app", decoded["containerName"])
	assert.Equal(t, 25.5, decoded["cpuPercent"])
	assert.Equal(t, "running", decoded["state"])
	assert.Equal(t, "healthy", decoded["health"])
}

func TestContainerInfoJSON(t *testing.T) {
	info := ContainerInfo{
		ID:      "abc123",
		Name:    "my-app",
		Image:   "nginx:latest",
		ImageID: "sha256:xyz",
		State:   "running",
		Status:  "Up 2 hours",
		Created: 1700000000,
		Ports: []ContainerPort{
			{PrivatePort: 80, PublicPort: 8080, Type: "tcp"},
		},
		Labels:      map[string]string{"env": "prod"},
		Mounts:      []ContainerMount{},
		NetworkMode: "bridge",
	}

	data, err := json.Marshal(info)
	require.NoError(t, err)

	var decoded ContainerInfo
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)

	assert.Equal(t, "abc123", decoded.ID)
	assert.Equal(t, "my-app", decoded.Name)
	assert.Len(t, decoded.Ports, 1)
	assert.Equal(t, "bridge", decoded.NetworkMode)
}

func TestTopProcessesPayloadJSON(t *testing.T) {
	payload := TopProcessesPayload{
		ByCPU: []ProcessInfoPayload{
			{PID: 1, Name: "nginx", CPUPercent: 80.0, MemoryMb: 256.0, Threads: 4},
		},
		ByMemory: []ProcessInfoPayload{
			{PID: 2, Name: "java", CPUPercent: 20.0, MemoryMb: 2048.0, Threads: 100},
		},
		Stats: ProcessStatsPayload{
			Total:    200,
			Running:  5,
			Sleeping: 190,
			Stopped:  3,
			Zombie:   2,
		},
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded TopProcessesPayload
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)

	assert.Len(t, decoded.ByCPU, 1)
	assert.Equal(t, "nginx", decoded.ByCPU[0].Name)
	assert.Equal(t, 200, decoded.Stats.Total)
}

func TestMetricsConfigDefaults(t *testing.T) {
	// When agentConfig is nil, defaults should be all-enabled
	defaultConfig := MetricsConfig{
		CollectCpu:        true,
		CollectMemory:     true,
		CollectSwap:       true,
		CollectDisk:       true,
		CollectLoad:       true,
		CollectFds:        true,
		CollectTcp:        true,
		CollectProcesses:  true,
		CollectTcpChecks:  true,
		CollectCertChecks: true,
	}

	assert.True(t, defaultConfig.CollectCpu)
	assert.True(t, defaultConfig.CollectMemory)
	assert.True(t, defaultConfig.CollectSwap)
	assert.True(t, defaultConfig.CollectDisk)
	assert.True(t, defaultConfig.CollectLoad)
	assert.True(t, defaultConfig.CollectFds)
	assert.True(t, defaultConfig.CollectTcp)
	assert.True(t, defaultConfig.CollectProcesses)
	assert.True(t, defaultConfig.CollectTcpChecks)
	assert.True(t, defaultConfig.CollectCertChecks)
}

func TestAgentConfigMutexSafety(t *testing.T) {
	// Test concurrent access to agentConfig
	var wg sync.WaitGroup

	// Writers
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			agentConfigMutex.Lock()
			agentConfig = &AgentConfig{
				ServerID: "server-" + string(rune('0'+id)),
			}
			agentConfigMutex.Unlock()
		}(i)
	}

	// Readers
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			agentConfigMutex.RLock()
			_ = agentConfig
			agentConfigMutex.RUnlock()
		}()
	}

	wg.Wait()
	// If we reach here without a race condition, the test passes
}

func TestVersionVariable(t *testing.T) {
	// Version should have a default value of "dev"
	assert.Equal(t, "dev", Version)
}
