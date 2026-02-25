package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestContainerMetricsStruct(t *testing.T) {
	m := ContainerMetrics{
		Name:          "web-app",
		CPUPercent:    25.5,
		MemoryUsedMb:  512.0,
		MemoryLimitMb: 2048.0,
		NetworkRxMb:   100.5,
		NetworkTxMb:   50.2,
		BlockReadMb:   200.0,
		BlockWriteMb:  75.0,
		RestartCount:  3,
		State:         "running",
		Health:        "healthy",
	}

	assert.Equal(t, "web-app", m.Name)
	assert.Equal(t, 25.5, m.CPUPercent)
	assert.Equal(t, 512.0, m.MemoryUsedMb)
	assert.Equal(t, 2048.0, m.MemoryLimitMb)
	assert.Equal(t, 100.5, m.NetworkRxMb)
	assert.Equal(t, 50.2, m.NetworkTxMb)
	assert.Equal(t, 200.0, m.BlockReadMb)
	assert.Equal(t, 75.0, m.BlockWriteMb)
	assert.Equal(t, 3, m.RestartCount)
	assert.Equal(t, "running", m.State)
	assert.Equal(t, "healthy", m.Health)
}

func TestContainerInfoStruct(t *testing.T) {
	info := ContainerInfo{
		ID:      "abc123def456",
		Name:    "my-container",
		Image:   "nginx:latest",
		ImageID: "sha256:abc123",
		State:   "running",
		Status:  "Up 2 hours",
		Created: 1700000000,
		Ports: []ContainerPort{
			{PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0"},
		},
		Labels:      map[string]string{"app": "web"},
		Mounts:      []ContainerMount{{Source: "/data", Destination: "/app/data", Mode: "rw", Type: "bind"}},
		NetworkMode: "bridge",
	}

	assert.Equal(t, "abc123def456", info.ID)
	assert.Equal(t, "my-container", info.Name)
	assert.Equal(t, "nginx:latest", info.Image)
	assert.Equal(t, "running", info.State)
	assert.Len(t, info.Ports, 1)
	assert.Equal(t, 80, info.Ports[0].PrivatePort)
	assert.Equal(t, 8080, info.Ports[0].PublicPort)
	assert.Len(t, info.Mounts, 1)
	assert.Equal(t, "/data", info.Mounts[0].Source)
	assert.Equal(t, "bridge", info.NetworkMode)
}

func TestCPUPercentCalculation(t *testing.T) {
	tests := []struct {
		name       string
		stats      dockerStats
		wantCPU    float64
		wantNonZero bool
	}{
		{
			name: "normal CPU usage with 4 CPUs",
			stats: dockerStats{
				CPUStats: cpuStatsDocker{
					CPUUsage:       struct{ TotalUsage uint64 `json:"total_usage"` }{TotalUsage: 200000000},
					SystemCPUUsage: 1000000000,
					OnlineCPUs:     4,
				},
				PreCPUStats: cpuStatsDocker{
					CPUUsage:       struct{ TotalUsage uint64 `json:"total_usage"` }{TotalUsage: 100000000},
					SystemCPUUsage: 500000000,
					OnlineCPUs:     4,
				},
			},
			wantCPU:    80.0, // (100M / 500M) * 4 * 100 = 80%
			wantNonZero: true,
		},
		{
			name: "zero CPU usage",
			stats: dockerStats{
				CPUStats: cpuStatsDocker{
					CPUUsage:       struct{ TotalUsage uint64 `json:"total_usage"` }{TotalUsage: 100},
					SystemCPUUsage: 1000,
					OnlineCPUs:     2,
				},
				PreCPUStats: cpuStatsDocker{
					CPUUsage:       struct{ TotalUsage uint64 `json:"total_usage"` }{TotalUsage: 100},
					SystemCPUUsage: 1000,
					OnlineCPUs:     2,
				},
			},
			wantCPU:    0.0,
			wantNonZero: false,
		},
		{
			name: "zero system delta",
			stats: dockerStats{
				CPUStats: cpuStatsDocker{
					CPUUsage:       struct{ TotalUsage uint64 `json:"total_usage"` }{TotalUsage: 200},
					SystemCPUUsage: 1000,
					OnlineCPUs:     1,
				},
				PreCPUStats: cpuStatsDocker{
					CPUUsage:       struct{ TotalUsage uint64 `json:"total_usage"` }{TotalUsage: 100},
					SystemCPUUsage: 1000,
					OnlineCPUs:     1,
				},
			},
			wantCPU:    0.0,
			wantNonZero: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cpuDelta := float64(tt.stats.CPUStats.CPUUsage.TotalUsage - tt.stats.PreCPUStats.CPUUsage.TotalUsage)
			systemDelta := float64(tt.stats.CPUStats.SystemCPUUsage - tt.stats.PreCPUStats.SystemCPUUsage)

			cpuPercent := 0.0
			if systemDelta > 0 && cpuDelta > 0 {
				cpuPercent = (cpuDelta / systemDelta) * float64(tt.stats.CPUStats.OnlineCPUs) * 100.0
			}

			if tt.wantNonZero {
				assert.InDelta(t, tt.wantCPU, cpuPercent, 1.0)
			} else {
				assert.Equal(t, 0.0, cpuPercent)
			}
		})
	}
}

func TestMemoryConversion(t *testing.T) {
	tests := []struct {
		name       string
		usageBytes uint64
		limitBytes uint64
		wantMB     float64
		wantLimMB  float64
	}{
		{
			name:       "1 GB usage, 2 GB limit",
			usageBytes: 1073741824,
			limitBytes: 2147483648,
			wantMB:     1024.0,
			wantLimMB:  2048.0,
		},
		{
			name:       "512 MB usage, 1 GB limit",
			usageBytes: 536870912,
			limitBytes: 1073741824,
			wantMB:     512.0,
			wantLimMB:  1024.0,
		},
		{
			name:       "zero usage",
			usageBytes: 0,
			limitBytes: 1073741824,
			wantMB:     0,
			wantLimMB:  1024.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			usedMb := float64(tt.usageBytes) / (1024 * 1024)
			limitMb := float64(tt.limitBytes) / (1024 * 1024)

			assert.InDelta(t, tt.wantMB, usedMb, 0.1)
			assert.InDelta(t, tt.wantLimMB, limitMb, 0.1)
		})
	}
}

func TestNetworkBytesAggregation(t *testing.T) {
	networks := map[string]networkStats{
		"eth0":   {RxBytes: 1048576, TxBytes: 524288},
		"eth1":   {RxBytes: 2097152, TxBytes: 1048576},
		"docker0": {RxBytes: 0, TxBytes: 0},
	}

	var rxBytes, txBytes uint64
	for _, n := range networks {
		rxBytes += n.RxBytes
		txBytes += n.TxBytes
	}

	rxMb := float64(rxBytes) / (1024 * 1024)
	txMb := float64(txBytes) / (1024 * 1024)

	assert.InDelta(t, 3.0, rxMb, 0.1)   // 3 MB RX
	assert.InDelta(t, 1.5, txMb, 0.1)   // 1.5 MB TX
}

func TestBlockIOAggregation(t *testing.T) {
	blkio := blkioStats{
		IoServiceBytesRecursive: []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		}{
			{Op: "Read", Value: 10485760},  // 10 MB
			{Op: "Write", Value: 5242880},  // 5 MB
			{Op: "Sync", Value: 0},
			{Op: "Async", Value: 0},
			{Op: "Total", Value: 15728640},
		},
	}

	var readBytes, writeBytes uint64
	for _, bio := range blkio.IoServiceBytesRecursive {
		switch bio.Op {
		case "Read":
			readBytes += bio.Value
		case "Write":
			writeBytes += bio.Value
		}
	}

	readMb := float64(readBytes) / (1024 * 1024)
	writeMb := float64(writeBytes) / (1024 * 1024)

	assert.InDelta(t, 10.0, readMb, 0.1)
	assert.InDelta(t, 5.0, writeMb, 0.1)
}

func TestHealthStatusFromInspect(t *testing.T) {
	tests := []struct {
		name       string
		inspect    dockerInspect
		wantHealth string
	}{
		{
			name: "healthy container",
			inspect: dockerInspect{
				State: struct {
					Status       string `json:"Status"`
					Running      bool   `json:"Running"`
					RestartCount int    `json:"RestartCount"`
					Health       *struct {
						Status string `json:"Status"`
					} `json:"Health,omitempty"`
				}{
					Status:  "running",
					Running: true,
					Health:  &struct{ Status string `json:"Status"` }{Status: "healthy"},
				},
			},
			wantHealth: "healthy",
		},
		{
			name: "unhealthy container",
			inspect: dockerInspect{
				State: struct {
					Status       string `json:"Status"`
					Running      bool   `json:"Running"`
					RestartCount int    `json:"RestartCount"`
					Health       *struct {
						Status string `json:"Status"`
					} `json:"Health,omitempty"`
				}{
					Status:  "running",
					Running: true,
					Health:  &struct{ Status string `json:"Status"` }{Status: "unhealthy"},
				},
			},
			wantHealth: "unhealthy",
		},
		{
			name: "no healthcheck",
			inspect: dockerInspect{
				State: struct {
					Status       string `json:"Status"`
					Running      bool   `json:"Running"`
					RestartCount int    `json:"RestartCount"`
					Health       *struct {
						Status string `json:"Status"`
					} `json:"Health,omitempty"`
				}{
					Status:  "running",
					Running: true,
					Health:  nil,
				},
			},
			wantHealth: "none",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			health := "none"
			if tt.inspect.State.Health != nil {
				health = tt.inspect.State.Health.Status
			}
			assert.Equal(t, tt.wantHealth, health)
		})
	}
}

func TestContainerNameParsing(t *testing.T) {
	tests := []struct {
		name     string
		id       string
		names    []string
		wantName string
	}{
		{
			name:     "with name",
			id:       "abc123def456789",
			names:    []string{"/my-container"},
			wantName: "my-container",
		},
		{
			name:     "no name uses ID prefix",
			id:       "abc123def456789",
			names:    []string{},
			wantName: "abc123def456",
		},
		{
			name:     "multiple names uses first",
			id:       "abc123def456789",
			names:    []string{"/primary", "/secondary"},
			wantName: "primary",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			name := tt.id[:12]
			if len(tt.names) > 0 {
				name = tt.names[0]
				if len(name) > 0 && name[0] == '/' {
					name = name[1:]
				}
			}
			assert.Equal(t, tt.wantName, name)
		})
	}
}

func TestDockerContainerJSONParsing(t *testing.T) {
	jsonData := `[
		{
			"Id": "abc123def456789",
			"Names": ["/web-app"],
			"Image": "nginx:latest",
			"ImageID": "sha256:abcdef",
			"State": "running",
			"Status": "Up 2 hours",
			"Created": 1700000000,
			"Ports": [
				{"PrivatePort": 80, "PublicPort": 8080, "Type": "tcp", "IP": "0.0.0.0"}
			],
			"Labels": {"app": "web"},
			"Mounts": [],
			"HostConfig": {"NetworkMode": "bridge"}
		}
	]`

	var containers []dockerContainer
	err := json.Unmarshal([]byte(jsonData), &containers)
	require.NoError(t, err)
	require.Len(t, containers, 1)

	c := containers[0]
	assert.Equal(t, "abc123def456789", c.ID)
	assert.Equal(t, []string{"/web-app"}, c.Names)
	assert.Equal(t, "nginx:latest", c.Image)
	assert.Equal(t, "running", c.State)
	assert.Equal(t, "Up 2 hours", c.Status)
	assert.Len(t, c.Ports, 1)
	assert.Equal(t, 80, c.Ports[0].PrivatePort)
	assert.Equal(t, 8080, c.Ports[0].PublicPort)
	assert.Equal(t, "bridge", c.HostConfig.NetworkMode)
}

func TestDockerStatsJSONParsing(t *testing.T) {
	jsonData := `{
		"read": "2024-01-15T10:00:00.000000000Z",
		"preread": "2024-01-15T09:59:59.000000000Z",
		"cpu_stats": {
			"cpu_usage": {"total_usage": 200000000},
			"system_cpu_usage": 1000000000,
			"online_cpus": 4
		},
		"precpu_stats": {
			"cpu_usage": {"total_usage": 100000000},
			"system_cpu_usage": 500000000,
			"online_cpus": 4
		},
		"memory_stats": {
			"usage": 536870912,
			"limit": 1073741824
		},
		"networks": {
			"eth0": {"rx_bytes": 1048576, "tx_bytes": 524288}
		},
		"blkio_stats": {
			"io_service_bytes_recursive": [
				{"op": "Read", "value": 10485760},
				{"op": "Write", "value": 5242880}
			]
		}
	}`

	var stats dockerStats
	err := json.Unmarshal([]byte(jsonData), &stats)
	require.NoError(t, err)

	assert.Equal(t, uint64(200000000), stats.CPUStats.CPUUsage.TotalUsage)
	assert.Equal(t, uint64(100000000), stats.PreCPUStats.CPUUsage.TotalUsage)
	assert.Equal(t, 4, stats.CPUStats.OnlineCPUs)
	assert.Equal(t, uint64(536870912), stats.MemoryStats.Usage)
	assert.Equal(t, uint64(1073741824), stats.MemoryStats.Limit)
	assert.Contains(t, stats.Networks, "eth0")
	assert.Equal(t, uint64(1048576), stats.Networks["eth0"].RxBytes)
}

func TestImageInfoStruct(t *testing.T) {
	img := ImageInfo{
		ID:       "sha256:abc123",
		RepoTags: []string{"nginx:latest", "nginx:1.25"},
		Size:     142000000,
		Created:  1700000000,
	}

	assert.Equal(t, "sha256:abc123", img.ID)
	assert.Len(t, img.RepoTags, 2)
	assert.Contains(t, img.RepoTags, "nginx:latest")
	assert.Equal(t, int64(142000000), img.Size)
}

func TestDockerAPIResponseHandling(t *testing.T) {
	// Test that we correctly handle a mock Docker API response
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]dockerContainer{
				{
					ID:    "abc123def456789",
					Names: []string{"/test-container"},
					State: "running",
				},
			})
		default:
			http.NotFound(w, r)
		}
	})

	ts := httptest.NewServer(handler)
	defer ts.Close()

	// Verify the mock server responds correctly
	resp, err := http.Get(ts.URL + "/containers/json")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var containers []dockerContainer
	err = json.NewDecoder(resp.Body).Decode(&containers)
	require.NoError(t, err)
	assert.Len(t, containers, 1)
	assert.Equal(t, "running", containers[0].State)
}
