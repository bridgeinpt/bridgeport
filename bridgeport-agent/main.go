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

// TCPCheckConfig defines a TCP port to check
type TCPCheckConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Name string `json:"name,omitempty"`
}

// CertCheckConfig defines a TLS endpoint to check
type CertCheckConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Name string `json:"name,omitempty"`
}

// ServiceHealthConfig represents a service that needs health checks
type ServiceHealthConfig struct {
	ContainerName  string            `json:"containerName"`
	HealthCheckURL string            `json:"healthCheckUrl"`
	TCPChecks      []TCPCheckConfig  `json:"tcpChecks,omitempty"`
	CertChecks     []CertCheckConfig `json:"certChecks,omitempty"`
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

// TCPCheckResult is the result of a TCP port check
type TCPCheckResult struct {
	ContainerName string  `json:"containerName"`
	Host          string  `json:"host"`
	Port          int     `json:"port"`
	Name          string  `json:"name,omitempty"`
	Success       bool    `json:"success"`
	DurationMs    int     `json:"durationMs"`
	Error         *string `json:"error,omitempty"`
}

// CertCheckResult is the result of a certificate check
type CertCheckResult struct {
	ContainerName   string  `json:"containerName"`
	Host            string  `json:"host"`
	Port            int     `json:"port"`
	Name            string  `json:"name,omitempty"`
	Success         bool    `json:"success"`
	DurationMs      int     `json:"durationMs"`
	ExpiresAt       *string `json:"expiresAt,omitempty"`
	DaysUntilExpiry *int    `json:"daysUntilExpiry,omitempty"`
	Issuer          *string `json:"issuer,omitempty"`
	Subject         *string `json:"subject,omitempty"`
	Error           *string `json:"error,omitempty"`
}

// agentConfig stores the current configuration from BridgePort
var agentConfig *AgentConfig
var agentConfigMutex sync.RWMutex

type MetricsPayload struct {
	CPUPercent          *float64              `json:"cpuPercent,omitempty"`
	MemoryUsedMb        *float64              `json:"memoryUsedMb,omitempty"`
	MemoryTotalMb       *float64              `json:"memoryTotalMb,omitempty"`
	SwapUsedMb          *float64              `json:"swapUsedMb,omitempty"`
	SwapTotalMb         *float64              `json:"swapTotalMb,omitempty"`
	DiskUsedGb          *float64              `json:"diskUsedGb,omitempty"`
	DiskTotalGb         *float64              `json:"diskTotalGb,omitempty"`
	LoadAvg1            *float64              `json:"loadAvg1,omitempty"`
	LoadAvg5            *float64              `json:"loadAvg5,omitempty"`
	LoadAvg15           *float64              `json:"loadAvg15,omitempty"`
	Uptime              *int                  `json:"uptime,omitempty"`
	OpenFDs             *int                  `json:"openFds,omitempty"`
	MaxFDs              *int                  `json:"maxFds,omitempty"`
	TCPEstablished      *int                  `json:"tcpEstablished,omitempty"`
	TCPListen           *int                  `json:"tcpListen,omitempty"`
	TCPTimeWait         *int                  `json:"tcpTimeWait,omitempty"`
	TCPCloseWait        *int                  `json:"tcpCloseWait,omitempty"`
	TCPTotal            *int                  `json:"tcpTotal,omitempty"`
	ServerHealthy       *bool                 `json:"serverHealthy,omitempty"` // Agent confirms server is reachable
	AgentVersion        *string               `json:"agentVersion,omitempty"`  // Agent version
	Services            []ServiceMetrics      `json:"services,omitempty"`
	ServiceHealthChecks []ServiceHealthResult `json:"serviceHealthChecks,omitempty"` // Health check results
	TCPCheckResults     []TCPCheckResult      `json:"tcpCheckResults,omitempty"`     // TCP port check results
	CertCheckResults    []CertCheckResult     `json:"certCheckResults,omitempty"`    // TLS cert check results
	Containers          []ContainerInfo       `json:"containers,omitempty"`          // Full container list for discovery
	TopProcesses        *TopProcessesPayload  `json:"topProcesses,omitempty"`        // Top processes by CPU/memory
}

// ContainerInfo mirrors collector.ContainerInfo for JSON serialization
type ContainerInfo struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Image       string            `json:"image"`
	ImageID     string            `json:"imageId"`
	State       string            `json:"state"`
	Status      string            `json:"status"`
	Created     int64             `json:"created"`
	Ports       []ContainerPort   `json:"ports"`
	Labels      map[string]string `json:"labels"`
	Mounts      []ContainerMount  `json:"mounts"`
	NetworkMode string            `json:"networkMode"`
}

type ContainerPort struct {
	PrivatePort int    `json:"privatePort"`
	PublicPort  int    `json:"publicPort,omitempty"`
	Type        string `json:"type"`
	IP          string `json:"ip,omitempty"`
}

type ContainerMount struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Mode        string `json:"mode"`
	Type        string `json:"type"`
}

type TopProcessesPayload struct {
	ByCPU    []ProcessInfoPayload `json:"byCpu"`
	ByMemory []ProcessInfoPayload `json:"byMemory"`
	Stats    ProcessStatsPayload  `json:"stats"`
}

type ProcessInfoPayload struct {
	PID        int     `json:"pid"`
	Name       string  `json:"name"`
	State      string  `json:"state"`
	CPUPercent float64 `json:"cpuPercent"`
	MemoryMb   float64 `json:"memoryMb"`
	Threads    int     `json:"threads"`
}

type ProcessStatsPayload struct {
	Total    int `json:"total"`
	Running  int `json:"running"`
	Sleeping int `json:"sleeping"`
	Stopped  int `json:"stopped"`
	Zombie   int `json:"zombie"`
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
		// Skip services without health check URLs
		if svc.HealthCheckURL == "" {
			continue
		}

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

// performTCPChecks performs TCP port connectivity checks
func performTCPChecks() []TCPCheckResult {
	agentConfigMutex.RLock()
	cfg := agentConfig
	agentConfigMutex.RUnlock()

	if cfg == nil || len(cfg.Services) == 0 {
		return nil
	}

	var results []TCPCheckResult

	for _, svc := range cfg.Services {
		if len(svc.TCPChecks) == 0 {
			continue
		}

		// Convert to collector types
		targets := make([]collector.TCPCheckConfig, len(svc.TCPChecks))
		for i, tc := range svc.TCPChecks {
			targets[i] = collector.TCPCheckConfig{
				Host: tc.Host,
				Port: tc.Port,
				Name: tc.Name,
			}
		}

		// Perform checks
		checkResults := collector.CheckTCPPorts(targets, 5*time.Second)

		// Convert results back
		for _, cr := range checkResults {
			result := TCPCheckResult{
				ContainerName: svc.ContainerName,
				Host:          cr.Host,
				Port:          cr.Port,
				Name:          cr.Name,
				Success:       cr.Success,
				DurationMs:    cr.DurationMs,
			}
			if cr.Error != "" {
				errStr := cr.Error
				result.Error = &errStr
			}
			results = append(results, result)
		}
	}

	return results
}

// performCertChecks performs TLS certificate expiry checks
func performCertChecks() []CertCheckResult {
	agentConfigMutex.RLock()
	cfg := agentConfig
	agentConfigMutex.RUnlock()

	if cfg == nil || len(cfg.Services) == 0 {
		return nil
	}

	var results []CertCheckResult

	for _, svc := range cfg.Services {
		if len(svc.CertChecks) == 0 {
			continue
		}

		// Convert to collector types
		targets := make([]collector.CertCheckConfig, len(svc.CertChecks))
		for i, cc := range svc.CertChecks {
			targets[i] = collector.CertCheckConfig{
				Host: cc.Host,
				Port: cc.Port,
				Name: cc.Name,
			}
		}

		// Perform checks
		checkResults := collector.CheckCertificates(targets, 10*time.Second)

		// Convert results back
		for _, cr := range checkResults {
			result := CertCheckResult{
				ContainerName: svc.ContainerName,
				Host:          cr.Host,
				Port:          cr.Port,
				Name:          cr.Name,
				Success:       cr.Success,
				DurationMs:    cr.DurationMs,
			}
			if cr.ExpiresAt != "" {
				expiresAt := cr.ExpiresAt
				result.ExpiresAt = &expiresAt
			}
			if cr.DaysUntilExpiry != 0 {
				days := cr.DaysUntilExpiry
				result.DaysUntilExpiry = &days
			}
			if cr.Issuer != "" {
				issuer := cr.Issuer
				result.Issuer = &issuer
			}
			if cr.Subject != "" {
				subject := cr.Subject
				result.Subject = &subject
			}
			if cr.Error != "" {
				errStr := cr.Error
				result.Error = &errStr
			}
			results = append(results, result)
		}
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

	// Perform TCP port connectivity checks
	tcpResults := performTCPChecks()
	if len(tcpResults) > 0 {
		payload.TCPCheckResults = tcpResults
	}

	// Perform TLS certificate expiry checks
	certResults := performCertChecks()
	if len(certResults) > 0 {
		payload.CertCheckResults = certResults
	}

	// Collect system metrics
	if sysMetrics, err := collector.CollectSystemMetrics(); err == nil {
		payload.CPUPercent = &sysMetrics.CPUPercent
		payload.MemoryUsedMb = &sysMetrics.MemoryUsedMb
		payload.MemoryTotalMb = &sysMetrics.MemoryTotalMb
		payload.SwapUsedMb = &sysMetrics.SwapUsedMb
		payload.SwapTotalMb = &sysMetrics.SwapTotalMb
		payload.DiskUsedGb = &sysMetrics.DiskUsedGb
		payload.DiskTotalGb = &sysMetrics.DiskTotalGb
		payload.LoadAvg1 = &sysMetrics.LoadAvg1
		payload.LoadAvg5 = &sysMetrics.LoadAvg5
		payload.LoadAvg15 = &sysMetrics.LoadAvg15
		payload.Uptime = &sysMetrics.Uptime
		payload.OpenFDs = &sysMetrics.OpenFDs
		payload.MaxFDs = &sysMetrics.MaxFDs
		payload.TCPEstablished = &sysMetrics.TCPConns.Established
		payload.TCPListen = &sysMetrics.TCPConns.Listen
		payload.TCPTimeWait = &sysMetrics.TCPConns.TimeWait
		payload.TCPCloseWait = &sysMetrics.TCPConns.CloseWait
		payload.TCPTotal = &sysMetrics.TCPConns.Total
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

	// Collect full container list for discovery
	if containerList, err := collector.CollectContainerList(); err == nil {
		for _, c := range containerList {
			ports := make([]ContainerPort, 0, len(c.Ports))
			for _, p := range c.Ports {
				ports = append(ports, ContainerPort{
					PrivatePort: p.PrivatePort,
					PublicPort:  p.PublicPort,
					Type:        p.Type,
					IP:          p.IP,
				})
			}
			mounts := make([]ContainerMount, 0, len(c.Mounts))
			for _, m := range c.Mounts {
				mounts = append(mounts, ContainerMount{
					Source:      m.Source,
					Destination: m.Destination,
					Mode:        m.Mode,
					Type:        m.Type,
				})
			}
			payload.Containers = append(payload.Containers, ContainerInfo{
				ID:          c.ID,
				Name:        c.Name,
				Image:       c.Image,
				ImageID:     c.ImageID,
				State:       c.State,
				Status:      c.Status,
				Created:     c.Created,
				Ports:       ports,
				Labels:      c.Labels,
				Mounts:      mounts,
				NetworkMode: c.NetworkMode,
			})
		}
	} else {
		log.Printf("Error collecting container list: %v", err)
	}

	// Collect top processes
	if topProcs, err := collector.CollectTopProcesses(10); err == nil {
		byCPU := make([]ProcessInfoPayload, 0, len(topProcs.ByCPU))
		for _, p := range topProcs.ByCPU {
			byCPU = append(byCPU, ProcessInfoPayload{
				PID:        p.PID,
				Name:       p.Name,
				State:      p.State,
				CPUPercent: p.CPUPercent,
				MemoryMb:   p.MemoryMb,
				Threads:    p.Threads,
			})
		}
		byMemory := make([]ProcessInfoPayload, 0, len(topProcs.ByMemory))
		for _, p := range topProcs.ByMemory {
			byMemory = append(byMemory, ProcessInfoPayload{
				PID:        p.PID,
				Name:       p.Name,
				State:      p.State,
				CPUPercent: p.CPUPercent,
				MemoryMb:   p.MemoryMb,
				Threads:    p.Threads,
			})
		}
		payload.TopProcesses = &TopProcessesPayload{
			ByCPU:    byCPU,
			ByMemory: byMemory,
			Stats: ProcessStatsPayload{
				Total:    topProcs.Stats.Total,
				Running:  topProcs.Stats.Running,
				Sleeping: topProcs.Stats.Sleeping,
				Stopped:  topProcs.Stats.Stopped,
				Zombie:   topProcs.Stats.Zombie,
			},
		}
	} else {
		log.Printf("Error collecting top processes: %v", err)
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
