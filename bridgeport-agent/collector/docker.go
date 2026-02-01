package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

type ContainerMetrics struct {
	Name          string
	CPUPercent    float64
	MemoryUsedMb  float64
	MemoryLimitMb float64
	NetworkRxMb   float64
	NetworkTxMb   float64
	BlockReadMb   float64
	BlockWriteMb  float64
	RestartCount  int
}

type dockerContainer struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	State string   `json:"State"`
}

type dockerStats struct {
	Read        string `json:"read"`
	PreRead     string `json:"preread"`
	CPUStats    cpuStatsDocker `json:"cpu_stats"`
	PreCPUStats cpuStatsDocker `json:"precpu_stats"`
	MemoryStats memStats       `json:"memory_stats"`
	Networks    map[string]networkStats `json:"networks"`
	BlkioStats  blkioStats `json:"blkio_stats"`
}

type cpuStatsDocker struct {
	CPUUsage struct {
		TotalUsage uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	SystemCPUUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs     int    `json:"online_cpus"`
}

type memStats struct {
	Usage uint64 `json:"usage"`
	Limit uint64 `json:"limit"`
}

type networkStats struct {
	RxBytes uint64 `json:"rx_bytes"`
	TxBytes uint64 `json:"tx_bytes"`
}

type blkioStats struct {
	IoServiceBytesRecursive []struct {
		Op    string `json:"op"`
		Value uint64 `json:"value"`
	} `json:"io_service_bytes_recursive"`
}

type dockerInspect struct {
	State struct {
		RestartCount int `json:"RestartCount"`
	} `json:"State"`
}

var dockerClient *http.Client

func init() {
	dockerClient = &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", "/var/run/docker.sock")
			},
		},
		Timeout: 5 * time.Second,
	}
}

func CollectDockerMetrics() ([]ContainerMetrics, error) {
	// List running containers
	resp, err := dockerClient.Get("http://docker/containers/json")
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}
	defer resp.Body.Close()

	var containers []dockerContainer
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil, fmt.Errorf("failed to decode containers: %w", err)
	}

	var metrics []ContainerMetrics
	for _, c := range containers {
		if c.State != "running" {
			continue
		}

		m, err := getContainerMetrics(c.ID, c.Names)
		if err != nil {
			continue // Skip containers that fail
		}
		metrics = append(metrics, *m)
	}

	return metrics, nil
}

func getContainerMetrics(id string, names []string) (*ContainerMetrics, error) {
	// Get container name
	name := id[:12]
	if len(names) > 0 {
		name = strings.TrimPrefix(names[0], "/")
	}

	// Get stats (one-shot)
	statsResp, err := dockerClient.Get(fmt.Sprintf("http://docker/containers/%s/stats?stream=false", id))
	if err != nil {
		return nil, err
	}
	defer statsResp.Body.Close()

	var stats dockerStats
	if err := json.NewDecoder(statsResp.Body).Decode(&stats); err != nil {
		return nil, err
	}

	// Get restart count from inspect
	inspectResp, err := dockerClient.Get(fmt.Sprintf("http://docker/containers/%s/json", id))
	if err != nil {
		return nil, err
	}
	defer inspectResp.Body.Close()

	var inspect dockerInspect
	if err := json.NewDecoder(inspectResp.Body).Decode(&inspect); err != nil {
		return nil, err
	}

	// Calculate CPU percentage
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(stats.CPUStats.SystemCPUUsage - stats.PreCPUStats.SystemCPUUsage)
	cpuPercent := 0.0
	if systemDelta > 0 && cpuDelta > 0 {
		cpuPercent = (cpuDelta / systemDelta) * float64(stats.CPUStats.OnlineCPUs) * 100.0
	}

	// Memory
	memUsedMb := float64(stats.MemoryStats.Usage) / (1024 * 1024)
	memLimitMb := float64(stats.MemoryStats.Limit) / (1024 * 1024)

	// Network
	var rxBytes, txBytes uint64
	for _, n := range stats.Networks {
		rxBytes += n.RxBytes
		txBytes += n.TxBytes
	}

	// Block I/O
	var readBytes, writeBytes uint64
	for _, bio := range stats.BlkioStats.IoServiceBytesRecursive {
		switch bio.Op {
		case "Read":
			readBytes += bio.Value
		case "Write":
			writeBytes += bio.Value
		}
	}

	return &ContainerMetrics{
		Name:          name,
		CPUPercent:    cpuPercent,
		MemoryUsedMb:  memUsedMb,
		MemoryLimitMb: memLimitMb,
		NetworkRxMb:   float64(rxBytes) / (1024 * 1024),
		NetworkTxMb:   float64(txBytes) / (1024 * 1024),
		BlockReadMb:   float64(readBytes) / (1024 * 1024),
		BlockWriteMb:  float64(writeBytes) / (1024 * 1024),
		RestartCount:  inspect.State.RestartCount,
	}, nil
}
