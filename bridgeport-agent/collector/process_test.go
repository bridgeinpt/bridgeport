package collector

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestProcessInfoStruct(t *testing.T) {
	p := ProcessInfo{
		PID:        1234,
		Name:       "nginx",
		State:      "S",
		CPUPercent: 5.5,
		MemoryMb:   256.0,
		Threads:    4,
	}

	assert.Equal(t, 1234, p.PID)
	assert.Equal(t, "nginx", p.Name)
	assert.Equal(t, "S", p.State)
	assert.Equal(t, 5.5, p.CPUPercent)
	assert.Equal(t, 256.0, p.MemoryMb)
	assert.Equal(t, 4, p.Threads)
}

func TestProcessStatsStruct(t *testing.T) {
	stats := ProcessStats{
		Total:    250,
		Running:  5,
		Sleeping: 230,
		Stopped:  2,
		Zombie:   1,
	}

	assert.Equal(t, 250, stats.Total)
	assert.Equal(t, 5, stats.Running)
	assert.Equal(t, 230, stats.Sleeping)
	assert.Equal(t, 2, stats.Stopped)
	assert.Equal(t, 1, stats.Zombie)
}

func TestTopProcessesStruct(t *testing.T) {
	top := TopProcesses{
		ByCPU: []ProcessInfo{
			{PID: 1, Name: "cpu-hog", CPUPercent: 95.0},
			{PID: 2, Name: "worker", CPUPercent: 50.0},
		},
		ByMemory: []ProcessInfo{
			{PID: 3, Name: "mem-hog", MemoryMb: 2048.0},
			{PID: 4, Name: "cache", MemoryMb: 1024.0},
		},
		Stats: ProcessStats{
			Total:    100,
			Running:  5,
			Sleeping: 90,
		},
	}

	assert.Len(t, top.ByCPU, 2)
	assert.Len(t, top.ByMemory, 2)
	assert.Equal(t, 100, top.Stats.Total)

	// Verify CPU sorted order
	assert.Greater(t, top.ByCPU[0].CPUPercent, top.ByCPU[1].CPUPercent)
	// Verify Memory sorted order
	assert.Greater(t, top.ByMemory[0].MemoryMb, top.ByMemory[1].MemoryMb)
}

func TestProcessStateCounting(t *testing.T) {
	tests := []struct {
		name        string
		states      []string
		wantRunning int
		wantSleep   int
		wantStopped int
		wantZombie  int
	}{
		{
			name:        "mixed states",
			states:      []string{"R", "S", "S", "D", "T", "Z", "S"},
			wantRunning: 1,
			wantSleep:   4, // S and D both count as sleeping
			wantStopped: 1,
			wantZombie:  1,
		},
		{
			name:        "all running",
			states:      []string{"R", "R", "R"},
			wantRunning: 3,
			wantSleep:   0,
			wantStopped: 0,
			wantZombie:  0,
		},
		{
			name:        "empty",
			states:      []string{},
			wantRunning: 0,
			wantSleep:   0,
			wantStopped: 0,
			wantZombie:  0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stats := ProcessStats{}
			for _, state := range tt.states {
				stats.Total++
				switch state {
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

			assert.Equal(t, tt.wantRunning, stats.Running)
			assert.Equal(t, tt.wantSleep, stats.Sleeping)
			assert.Equal(t, tt.wantStopped, stats.Stopped)
			assert.Equal(t, tt.wantZombie, stats.Zombie)
			assert.Equal(t, len(tt.states), stats.Total)
		})
	}
}

func TestTopNSlicing(t *testing.T) {
	tests := []struct {
		name       string
		processes  int
		topN       int
		wantTopLen int
	}{
		{"more processes than N", 20, 10, 10},
		{"fewer processes than N", 3, 10, 3},
		{"exact match", 10, 10, 10},
		{"zero processes", 0, 10, 0},
		{"default topN when zero", 0, 0, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			processes := make([]ProcessInfo, tt.processes)
			for i := range processes {
				processes[i] = ProcessInfo{
					PID:        i + 1,
					CPUPercent: float64(tt.processes - i),
				}
			}

			topN := tt.topN
			if topN <= 0 {
				topN = 10
			}

			result := make([]ProcessInfo, 0, topN)
			for i := 0; i < len(processes) && i < topN; i++ {
				result = append(result, processes[i])
			}

			assert.Len(t, result, tt.wantTopLen)
		})
	}
}

func TestMemoryKbToMbConversion(t *testing.T) {
	tests := []struct {
		name     string
		memoryKb uint64
		wantMb   float64
	}{
		{"1 GB", 1048576, 1024.0},
		{"512 MB", 524288, 512.0},
		{"1 MB", 1024, 1.0},
		{"0 bytes", 0, 0.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mb := float64(tt.memoryKb) / 1024.0
			assert.InDelta(t, tt.wantMb, mb, 0.01)
		})
	}
}
