package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"bridgeport-agent/collector"
)

// Version is set at build time
var Version = "dev"

type Config struct {
	ServerURL string
	Token     string
	Interval  time.Duration
}

// ServiceHealthConfig represents a service that needs health checks
type ServiceHealthConfig struct {
	ContainerName  string `json:"containerName"`
	HealthCheckURL string `json:"healthCheckUrl"`
}

// AgentConfig is the configuration fetched from BridgePort
type AgentConfig struct {
	ServerID   string                `json:"serverId"`
	ServerName string                `json:"serverName"`
	Services   []ServiceHealthConfig `json:"services"`
}

// ServiceHealthResult is the result of a health check
type ServiceHealthResult struct {
	ContainerName  string  `json:"containerName"`
	HealthCheckURL string  `json:"healthCheckUrl"`
	Success        bool    `json:"success"`
	StatusCode     *int    `json:"statusCode,omitempty"`
	DurationMs     *int    `json:"durationMs,omitempty"`
	CheckedAt      string  `json:"checkedAt"`
	Error          *string `json:"error,omitempty"`
}

// agentConfig stores the current configuration from BridgePort
var agentConfig *AgentConfig
var agentConfigMutex sync.RWMutex

type MetricsPayload struct {
	CPUPercent          *float64              `json:"cpuPercent,omitempty"`
	MemoryUsedMb        *float64              `json:"memoryUsedMb,omitempty"`
	MemoryTotalMb       *float64              `json:"memoryTotalMb,omitempty"`
	DiskUsedGb          *float64              `json:"diskUsedGb,omitempty"`
	DiskTotalGb         *float64              `json:"diskTotalGb,omitempty"`
	LoadAvg1            *float64              `json:"loadAvg1,omitempty"`
	LoadAvg5            *float64              `json:"loadAvg5,omitempty"`
	LoadAvg15           *float64              `json:"loadAvg15,omitempty"`
	Uptime              *int                  `json:"uptime,omitempty"`
	ServerHealthy       *bool                 `json:"serverHealthy,omitempty"` // Agent confirms server is reachable
	AgentVersion        *string               `json:"agentVersion,omitempty"`  // Agent version
	Services            []ServiceMetrics      `json:"services,omitempty"`
	ServiceHealthChecks []ServiceHealthResult `json:"serviceHealthChecks,omitempty"` // Health check results
}

type ServiceMetrics struct {
	ContainerName string   `json:"containerName"`
	CPUPercent    *float64 `json:"cpuPercent,omitempty"`
	MemoryUsedMb  *float64 `json:"memoryUsedMb,omitempty"`
	MemoryLimitMb *float64 `json:"memoryLimitMb,omitempty"`
	NetworkRxMb   *float64 `json:"networkRxMb,omitempty"`
	NetworkTxMb   *float64 `json:"networkTxMb,omitempty"`
	BlockReadMb   *float64 `json:"blockReadMb,omitempty"`
	BlockWriteMb  *float64 `json:"blockWriteMb,omitempty"`
	RestartCount  *int     `json:"restartCount,omitempty"`
	State         *string  `json:"state,omitempty"`  // "running", "stopped", "exited", etc.
	Health        *string  `json:"health,omitempty"` // "healthy", "unhealthy", "none", ""
}

func main() {
	serverURL := flag.String("server", "", "BridgePort server URL (e.g., https://deploy.example.com)")
	token := flag.String("token", "", "Agent authentication token")
	interval := flag.Duration("interval", 30*time.Second, "Collection interval")
	flag.Parse()

	// Allow environment variables as fallback
	if *serverURL == "" {
		*serverURL = os.Getenv("BRIDGEPORT_SERVER")
	}
	if *token == "" {
		*token = os.Getenv("BRIDGEPORT_TOKEN")
	}

	if *serverURL == "" || *token == "" {
		log.Fatal("Server URL and token are required. Use -server and -token flags or BRIDGEPORT_SERVER and BRIDGEPORT_TOKEN env vars.")
	}

	config := Config{
		ServerURL: *serverURL,
		Token:     *token,
		Interval:  *interval,
	}

	log.Printf("BridgePort Agent starting (version %s)", Version)
	log.Printf("Server: %s", config.ServerURL)
	log.Printf("Interval: %s", config.Interval)

	// Handle shutdown gracefully
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Start config fetching goroutine
	go configFetcher(config)

	ticker := time.NewTicker(config.Interval)
	defer ticker.Stop()

	// Collect immediately on start
	collectAndSend(config)

	for {
		select {
		case <-ticker.C:
			collectAndSend(config)
		case sig := <-sigChan:
			log.Printf("Received signal %v, shutting down", sig)
			return
		}
	}
}

// configFetcher periodically fetches configuration from BridgePort
func configFetcher(config Config) {
	// Fetch immediately on start
	fetchConfig(config)

	// Then fetch every 60 seconds
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		fetchConfig(config)
	}
}

// fetchConfig fetches the agent configuration from BridgePort
func fetchConfig(config Config) {
	url := fmt.Sprintf("%s/api/agent/config", config.ServerURL)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("Error creating config request: %v", err)
		return
	}

	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", config.Token))

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Error fetching config: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Config fetch failed with status %d", resp.StatusCode)
		return
	}

	var cfg AgentConfig
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		log.Printf("Error decoding config: %v", err)
		return
	}

	agentConfigMutex.Lock()
	agentConfig = &cfg
	agentConfigMutex.Unlock()

	log.Printf("Config updated: %d services with health checks", len(cfg.Services))
}

// performHealthChecks performs HTTP health checks on services
func performHealthChecks() []ServiceHealthResult {
	agentConfigMutex.RLock()
	cfg := agentConfig
	agentConfigMutex.RUnlock()

	if cfg == nil || len(cfg.Services) == 0 {
		return nil
	}

	results := make([]ServiceHealthResult, 0, len(cfg.Services))
	client := &http.Client{Timeout: 10 * time.Second}

	for _, svc := range cfg.Services {
		result := ServiceHealthResult{
			ContainerName:  svc.ContainerName,
			HealthCheckURL: svc.HealthCheckURL,
			CheckedAt:      time.Now().UTC().Format(time.RFC3339),
		}

		start := time.Now()
		resp, err := client.Get(svc.HealthCheckURL)
		duration := int(time.Since(start).Milliseconds())
		result.DurationMs = &duration

		if err != nil {
			result.Success = false
			errStr := err.Error()
			result.Error = &errStr
		} else {
			resp.Body.Close()
			result.StatusCode = &resp.StatusCode
			result.Success = resp.StatusCode >= 200 && resp.StatusCode < 400
		}

		results = append(results, result)
	}

	return results
}

func collectAndSend(config Config) {
	payload := MetricsPayload{}

	// Agent is running = server is healthy (reachable)
	serverHealthy := true
	payload.ServerHealthy = &serverHealthy

	// Report agent version
	version := Version
	payload.AgentVersion = &version

	// Perform health checks on services
	healthResults := performHealthChecks()
	if len(healthResults) > 0 {
		payload.ServiceHealthChecks = healthResults
	}

	// Collect system metrics
	if sysMetrics, err := collector.CollectSystemMetrics(); err == nil {
		payload.CPUPercent = &sysMetrics.CPUPercent
		payload.MemoryUsedMb = &sysMetrics.MemoryUsedMb
		payload.MemoryTotalMb = &sysMetrics.MemoryTotalMb
		payload.DiskUsedGb = &sysMetrics.DiskUsedGb
		payload.DiskTotalGb = &sysMetrics.DiskTotalGb
		payload.LoadAvg1 = &sysMetrics.LoadAvg1
		payload.LoadAvg5 = &sysMetrics.LoadAvg5
		payload.LoadAvg15 = &sysMetrics.LoadAvg15
		payload.Uptime = &sysMetrics.Uptime
	} else {
		log.Printf("Error collecting system metrics: %v", err)
	}

	// Collect Docker container metrics
	if containers, err := collector.CollectDockerMetrics(); err == nil {
		for _, c := range containers {
			state := c.State
			health := c.Health
			sm := ServiceMetrics{
				ContainerName: c.Name,
				CPUPercent:    &c.CPUPercent,
				MemoryUsedMb:  &c.MemoryUsedMb,
				MemoryLimitMb: &c.MemoryLimitMb,
				NetworkRxMb:   &c.NetworkRxMb,
				NetworkTxMb:   &c.NetworkTxMb,
				BlockReadMb:   &c.BlockReadMb,
				BlockWriteMb:  &c.BlockWriteMb,
				RestartCount:  &c.RestartCount,
				State:         &state,
				Health:        &health,
			}
			payload.Services = append(payload.Services, sm)
		}
	} else {
		log.Printf("Error collecting Docker metrics: %v", err)
	}

	// Send to server
	if err := sendMetrics(config, payload); err != nil {
		log.Printf("Error sending metrics: %v", err)
	} else {
		log.Printf("Metrics sent successfully")
	}
}

func sendMetrics(config Config, payload MetricsPayload) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal metrics: %w", err)
	}

	url := fmt.Sprintf("%s/api/metrics/ingest", config.ServerURL)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(data))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", config.Token))

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned status %d", resp.StatusCode)
	}

	return nil
}
