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
	"syscall"
	"time"

	"bridgeport-agent/collector"
)

type Config struct {
	ServerURL string
	Token     string
	Interval  time.Duration
}

type MetricsPayload struct {
	CPUPercent    *float64         `json:"cpuPercent,omitempty"`
	MemoryUsedMb  *float64         `json:"memoryUsedMb,omitempty"`
	MemoryTotalMb *float64         `json:"memoryTotalMb,omitempty"`
	DiskUsedGb    *float64         `json:"diskUsedGb,omitempty"`
	DiskTotalGb   *float64         `json:"diskTotalGb,omitempty"`
	LoadAvg1      *float64         `json:"loadAvg1,omitempty"`
	LoadAvg5      *float64         `json:"loadAvg5,omitempty"`
	LoadAvg15     *float64         `json:"loadAvg15,omitempty"`
	Uptime        *int             `json:"uptime,omitempty"`
	Services      []ServiceMetrics `json:"services,omitempty"`
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

	log.Printf("BridgePort Agent starting")
	log.Printf("Server: %s", config.ServerURL)
	log.Printf("Interval: %s", config.Interval)

	// Handle shutdown gracefully
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

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

func collectAndSend(config Config) {
	payload := MetricsPayload{}

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
