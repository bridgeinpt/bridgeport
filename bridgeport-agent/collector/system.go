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
	DiskUsedGb    float64
	DiskTotalGb   float64
	LoadAvg1      float64
	LoadAvg5      float64
	LoadAvg15     float64
	Uptime        int
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

	// Memory
	if memTotal, memUsed, err := getMemory(); err == nil {
		metrics.MemoryTotalMb = memTotal
		metrics.MemoryUsedMb = memUsed
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

func getMemory() (float64, float64, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()

	var memTotal, memAvailable uint64
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
		}
	}

	totalMb := float64(memTotal) / 1024
	usedMb := float64(memTotal-memAvailable) / 1024

	return totalMb, usedMb, nil
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
