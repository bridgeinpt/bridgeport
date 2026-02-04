package collector

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ProcessInfo represents a single process
type ProcessInfo struct {
	PID        int     `json:"pid"`
	Name       string  `json:"name"`
	State      string  `json:"state"`
	CPUPercent float64 `json:"cpuPercent"`
	MemoryMb   float64 `json:"memoryMb"`
	Threads    int     `json:"threads"`
}

// ProcessStats contains aggregate process statistics
type ProcessStats struct {
	Total    int `json:"total"`
	Running  int `json:"running"`
	Sleeping int `json:"sleeping"`
	Stopped  int `json:"stopped"`
	Zombie   int `json:"zombie"`
}

// TopProcesses contains the top processes by CPU and memory
type TopProcesses struct {
	ByCPU    []ProcessInfo `json:"byCpu"`
	ByMemory []ProcessInfo `json:"byMemory"`
	Stats    ProcessStats  `json:"stats"`
}

// CollectTopProcesses returns top N processes by CPU and memory usage
func CollectTopProcesses(topN int) (*TopProcesses, error) {
	if topN <= 0 {
		topN = 10
	}

	// Get system memory total for percentage calculation
	memTotal := getSystemMemoryKb()

	// Get total CPU time for percentage calculation
	totalCPU := getTotalCPUTime()

	// Read all processes
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}

	var processes []ProcessInfo
	stats := ProcessStats{}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue // Not a PID directory
		}

		proc, err := readProcess(pid, memTotal, totalCPU)
		if err != nil {
			continue
		}

		processes = append(processes, *proc)
		stats.Total++

		switch proc.State {
		case "R":
			stats.Running++
		case "S", "D":
			stats.Sleeping++
		case "T":
			stats.Stopped++
		case "Z":
			stats.Zombie++
		}
	}

	// Sort by CPU and get top N
	sort.Slice(processes, func(i, j int) bool {
		return processes[i].CPUPercent > processes[j].CPUPercent
	})
	byCPU := make([]ProcessInfo, 0, topN)
	for i := 0; i < len(processes) && i < topN; i++ {
		byCPU = append(byCPU, processes[i])
	}

	// Sort by memory and get top N
	sort.Slice(processes, func(i, j int) bool {
		return processes[i].MemoryMb > processes[j].MemoryMb
	})
	byMemory := make([]ProcessInfo, 0, topN)
	for i := 0; i < len(processes) && i < topN; i++ {
		byMemory = append(byMemory, processes[i])
	}

	return &TopProcesses{
		ByCPU:    byCPU,
		ByMemory: byMemory,
		Stats:    stats,
	}, nil
}

func readProcess(pid int, memTotalKb uint64, totalCPU uint64) (*ProcessInfo, error) {
	procPath := filepath.Join("/proc", strconv.Itoa(pid))

	// Read /proc/[pid]/stat
	statData, err := os.ReadFile(filepath.Join(procPath, "stat"))
	if err != nil {
		return nil, err
	}

	// Parse stat - format: pid (comm) state ppid pgrp session tty_nr ...
	// The comm field can contain spaces and parentheses, so we need to parse carefully
	statStr := string(statData)

	// Find the last ')' to get past the comm field
	lastParen := strings.LastIndex(statStr, ")")
	if lastParen == -1 {
		return nil, err
	}

	// Get comm (name) between first '(' and last ')'
	firstParen := strings.Index(statStr, "(")
	name := ""
	if firstParen != -1 && lastParen > firstParen {
		name = statStr[firstParen+1 : lastParen]
	}

	// Parse fields after comm
	fields := strings.Fields(statStr[lastParen+2:])
	if len(fields) < 20 {
		return nil, err
	}

	state := fields[0]
	utime, _ := strconv.ParseUint(fields[11], 10, 64) // field 14 in stat, 11 after comm
	stime, _ := strconv.ParseUint(fields[12], 10, 64) // field 15 in stat
	numThreads, _ := strconv.Atoi(fields[17])         // field 20 in stat

	// Calculate CPU percentage (approximate - based on total CPU time)
	cpuPercent := 0.0
	if totalCPU > 0 {
		cpuPercent = float64(utime+stime) / float64(totalCPU) * 100.0
	}

	// Read /proc/[pid]/status for memory info (more reliable than statm)
	memoryKb := uint64(0)
	statusFile, err := os.Open(filepath.Join(procPath, "status"))
	if err == nil {
		scanner := bufio.NewScanner(statusFile)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "VmRSS:") {
				parts := strings.Fields(line)
				if len(parts) >= 2 {
					memoryKb, _ = strconv.ParseUint(parts[1], 10, 64)
				}
				break
			}
		}
		statusFile.Close()
	}

	return &ProcessInfo{
		PID:        pid,
		Name:       name,
		State:      state,
		CPUPercent: cpuPercent,
		MemoryMb:   float64(memoryKb) / 1024.0,
		Threads:    numThreads,
	}, nil
}

func getSystemMemoryKb() uint64 {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, _ := strconv.ParseUint(fields[1], 10, 64)
				return val
			}
		}
	}
	return 0
}

func getTotalCPUTime() uint64 {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)
			var total uint64
			for i := 1; i < len(fields); i++ {
				val, _ := strconv.ParseUint(fields[i], 10, 64)
				total += val
			}
			return total
		}
	}
	return 0
}
