package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type SystemMetrics struct {
	CPUPercent    float64
	MemoryUsedMb  float64
	MemoryTotalMb float64
	SwapUsedMb    float64
	SwapTotalMb   float64
	DiskUsedGb    float64
	DiskTotalGb   float64
	LoadAvg1      float64
	LoadAvg5      float64
	LoadAvg15     float64
	Uptime        int
	OpenFDs       int
	MaxFDs        int
	TCPConns      TCPConnections
}

type TCPConnections struct {
	Established int
	Listen      int
	TimeWait    int
	CloseWait   int
	Total       int
}

var lastCPUStats cpuStats

type cpuStats struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
	timestamp                                              time.Time
}

func CollectSystemMetrics() (*SystemMetrics, error) {
	metrics := &SystemMetrics{}

	// CPU
	if cpu, err := getCPUPercent(); err == nil {
		metrics.CPUPercent = cpu
	}

	// Memory and Swap (from same source)
	if memInfo, err := getMemoryInfo(); err == nil {
		metrics.MemoryTotalMb = memInfo.memTotalMb
		metrics.MemoryUsedMb = memInfo.memUsedMb
		metrics.SwapTotalMb = memInfo.swapTotalMb
		metrics.SwapUsedMb = memInfo.swapUsedMb
	}

	// Disk
	if diskTotal, diskUsed, err := getDisk("/"); err == nil {
		metrics.DiskTotalGb = diskTotal
		metrics.DiskUsedGb = diskUsed
	}

	// Load average
	if load1, load5, load15, err := getLoadAvg(); err == nil {
		metrics.LoadAvg1 = load1
		metrics.LoadAvg5 = load5
		metrics.LoadAvg15 = load15
	}

	// Uptime
	if uptime, err := getUptime(); err == nil {
		metrics.Uptime = uptime
	}

	// File descriptors
	if openFDs, maxFDs, err := getFileDescriptors(); err == nil {
		metrics.OpenFDs = openFDs
		metrics.MaxFDs = maxFDs
	}

	// TCP connections
	if tcpConns, err := getTCPConnections(); err == nil {
		metrics.TCPConns = tcpConns
	}

	return metrics, nil
}

func getCPUPercent() (float64, error) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return 0, scanner.Err()
	}

	fields := strings.Fields(scanner.Text())
	if len(fields) < 8 || fields[0] != "cpu" {
		return 0, nil
	}

	var current cpuStats
	current.user, _ = strconv.ParseUint(fields[1], 10, 64)
	current.nice, _ = strconv.ParseUint(fields[2], 10, 64)
	current.system, _ = strconv.ParseUint(fields[3], 10, 64)
	current.idle, _ = strconv.ParseUint(fields[4], 10, 64)
	current.iowait, _ = strconv.ParseUint(fields[5], 10, 64)
	current.irq, _ = strconv.ParseUint(fields[6], 10, 64)
	current.softirq, _ = strconv.ParseUint(fields[7], 10, 64)
	if len(fields) > 8 {
		current.steal, _ = strconv.ParseUint(fields[8], 10, 64)
	}
	current.timestamp = time.Now()

	// If this is the first read, store and return 0
	if lastCPUStats.timestamp.IsZero() {
		lastCPUStats = current
		return 0, nil
	}

	prevTotal := lastCPUStats.user + lastCPUStats.nice + lastCPUStats.system + lastCPUStats.idle +
		lastCPUStats.iowait + lastCPUStats.irq + lastCPUStats.softirq + lastCPUStats.steal
	currTotal := current.user + current.nice + current.system + current.idle +
		current.iowait + current.irq + current.softirq + current.steal

	prevIdle := lastCPUStats.idle + lastCPUStats.iowait
	currIdle := current.idle + current.iowait

	totalDelta := float64(currTotal - prevTotal)
	idleDelta := float64(currIdle - prevIdle)

	lastCPUStats = current

	if totalDelta == 0 {
		return 0, nil
	}

	return (totalDelta - idleDelta) / totalDelta * 100, nil
}

type memoryInfo struct {
	memTotalMb  float64
	memUsedMb   float64
	swapTotalMb float64
	swapUsedMb  float64
}

func getMemoryInfo() (*memoryInfo, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var memTotal, memAvailable, swapTotal, swapFree uint64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		value, _ := strconv.ParseUint(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			memTotal = value
		case "MemAvailable:":
			memAvailable = value
		case "SwapTotal:":
			swapTotal = value
		case "SwapFree:":
			swapFree = value
		}
	}

	return &memoryInfo{
		memTotalMb:  float64(memTotal) / 1024,
		memUsedMb:   float64(memTotal-memAvailable) / 1024,
		swapTotalMb: float64(swapTotal) / 1024,
		swapUsedMb:  float64(swapTotal-swapFree) / 1024,
	}, nil
}

func getDisk(path string) (float64, float64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}

	totalBytes := stat.Blocks * uint64(stat.Bsize)
	freeBytes := stat.Bfree * uint64(stat.Bsize)
	usedBytes := totalBytes - freeBytes

	totalGb := float64(totalBytes) / (1024 * 1024 * 1024)
	usedGb := float64(usedBytes) / (1024 * 1024 * 1024)

	return totalGb, usedGb, nil
}

func getLoadAvg() (float64, float64, float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}

	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0, nil
	}

	load1, _ := strconv.ParseFloat(fields[0], 64)
	load5, _ := strconv.ParseFloat(fields[1], 64)
	load15, _ := strconv.ParseFloat(fields[2], 64)

	return load1, load5, load15, nil
}

func getUptime() (int, error) {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}

	fields := strings.Fields(string(data))
	if len(fields) < 1 {
		return 0, nil
	}

	uptime, _ := strconv.ParseFloat(fields[0], 64)
	return int(uptime), nil
}

func getFileDescriptors() (int, int, error) {
	data, err := os.ReadFile("/proc/sys/fs/file-nr")
	if err != nil {
		return 0, 0, err
	}

	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, nil
	}

	// file-nr format: allocated  free  maximum
	allocated, _ := strconv.Atoi(fields[0])
	maximum, _ := strconv.Atoi(fields[2])

	return allocated, maximum, nil
}

func getTCPConnections() (TCPConnections, error) {
	conns := TCPConnections{}

	// Parse both IPv4 and IPv6 TCP connections
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		file, err := os.Open(path)
		if err != nil {
			continue // tcp6 might not exist
		}

		scanner := bufio.NewScanner(file)
		// Skip header line
		scanner.Scan()

		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 4 {
				continue
			}

			// Field 3 is the state (hex)
			state, err := strconv.ParseInt(fields[3], 16, 32)
			if err != nil {
				continue
			}

			conns.Total++

			// TCP state codes from kernel
			switch state {
			case 0x01: // ESTABLISHED
				conns.Established++
			case 0x0A: // LISTEN
				conns.Listen++
			case 0x06: // TIME_WAIT
				conns.TimeWait++
			case 0x08: // CLOSE_WAIT
				conns.CloseWait++
			}
		}
		file.Close()
	}

	return conns, nil
}
