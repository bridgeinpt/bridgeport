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
	State         string // "running", "stopped", "exited", etc.
	Health        string // "healthy", "unhealthy", "none" (no healthcheck), "" (starting)
}

// ContainerInfo provides full container details for discovery
type ContainerInfo struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Image     string            `json:"image"`
	ImageID   string            `json:"imageId"`
	State     string            `json:"state"`
	Status    string            `json:"status"` // Human-readable status like "Up 2 hours"
	Created   int64             `json:"created"`
	Ports     []ContainerPort   `json:"ports"`
	Labels    map[string]string `json:"labels"`
	Mounts    []ContainerMount  `json:"mounts"`
	NetworkMode string          `json:"networkMode"`
}

type ContainerPort struct {
	PrivatePort int    `json:"privatePort"`
	PublicPort  int    `json:"publicPort,omitempty"`
	Type        string `json:"type"` // tcp or udp
	IP          string `json:"ip,omitempty"`
}

type ContainerMount struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Mode        string `json:"mode"`
	Type        string `json:"type"` // bind, volume, tmpfs
}

// ImageInfo provides details about images on the server
type ImageInfo struct {
	ID        string   `json:"id"`
	RepoTags  []string `json:"repoTags"`
	Size      int64    `json:"size"`
	Created   int64    `json:"created"`
}

type dockerContainer struct {
	ID         string            `json:"Id"`
	Names      []string          `json:"Names"`
	Image      string            `json:"Image"`
	ImageID    string            `json:"ImageID"`
	State      string            `json:"State"`
	Status     string            `json:"Status"`
	Created    int64             `json:"Created"`
	Ports      []dockerPort      `json:"Ports"`
	Labels     map[string]string `json:"Labels"`
	Mounts     []dockerMount     `json:"Mounts"`
	HostConfig struct {
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
}

type dockerPort struct {
	PrivatePort int    `json:"PrivatePort"`
	PublicPort  int    `json:"PublicPort"`
	Type        string `json:"Type"`
	IP          string `json:"IP"`
}

type dockerMount struct {
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	Mode        string `json:"Mode"`
	Type        string `json:"Type"`
}

type dockerImage struct {
	ID       string   `json:"Id"`
	RepoTags []string `json:"RepoTags"`
	Size     int64    `json:"Size"`
	Created  int64    `json:"Created"`
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
		Status       string `json:"Status"`
		Running      bool   `json:"Running"`
		RestartCount int    `json:"RestartCount"`
		Health       *struct {
			Status string `json:"Status"`
		} `json:"Health,omitempty"`
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

	// Determine health status
	health := "none" // No healthcheck configured
	if inspect.State.Health != nil {
		health = inspect.State.Health.Status
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
		State:         inspect.State.Status,
		Health:        health,
	}, nil
}

// CollectContainerList returns all containers (running and stopped) with full details
func CollectContainerList() ([]ContainerInfo, error) {
	// List all containers (including stopped)
	resp, err := dockerClient.Get("http://docker/containers/json?all=true")
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}
	defer resp.Body.Close()

	var containers []dockerContainer
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil, fmt.Errorf("failed to decode containers: %w", err)
	}

	result := make([]ContainerInfo, 0, len(containers))
	for _, c := range containers {
		name := c.ID[:12]
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		// Convert ports
		ports := make([]ContainerPort, 0, len(c.Ports))
		for _, p := range c.Ports {
			ports = append(ports, ContainerPort{
				PrivatePort: p.PrivatePort,
				PublicPort:  p.PublicPort,
				Type:        p.Type,
				IP:          p.IP,
			})
		}

		// Convert mounts
		mounts := make([]ContainerMount, 0, len(c.Mounts))
		for _, m := range c.Mounts {
			mounts = append(mounts, ContainerMount{
				Source:      m.Source,
				Destination: m.Destination,
				Mode:        m.Mode,
				Type:        m.Type,
			})
		}

		result = append(result, ContainerInfo{
			ID:          c.ID,
			Name:        name,
			Image:       c.Image,
			ImageID:     c.ImageID,
			State:       c.State,
			Status:      c.Status,
			Created:     c.Created,
			Ports:       ports,
			Labels:      c.Labels,
			Mounts:      mounts,
			NetworkMode: c.HostConfig.NetworkMode,
		})
	}

	return result, nil
}

// CollectImageList returns all images on the server
func CollectImageList() ([]ImageInfo, error) {
	resp, err := dockerClient.Get("http://docker/images/json")
	if err != nil {
		return nil, fmt.Errorf("failed to list images: %w", err)
	}
	defer resp.Body.Close()

	var images []dockerImage
	if err := json.NewDecoder(resp.Body).Decode(&images); err != nil {
		return nil, fmt.Errorf("failed to decode images: %w", err)
	}

	result := make([]ImageInfo, 0, len(images))
	for _, img := range images {
		result = append(result, ImageInfo{
			ID:       img.ID,
			RepoTags: img.RepoTags,
			Size:     img.Size,
			Created:  img.Created,
		})
	}

	return result, nil
}
