package output

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestStatusColor(t *testing.T) {
	tests := []struct {
		name   string
		status string
	}{
		{"healthy", "healthy"},
		{"running", "running"},
		{"up", "up"},
		{"online", "online"},
		{"unhealthy", "unhealthy"},
		{"error", "error"},
		{"failed", "failed"},
		{"down", "down"},
		{"offline", "offline"},
		{"starting", "starting"},
		{"stopping", "stopping"},
		{"pending", "pending"},
		{"unknown", "unknown"},
		{"custom", "custom"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := StatusColor(tt.status)
			assert.NotEmpty(t, result)
			// The result should contain the original status text
			assert.Contains(t, result, tt.status)
		})
	}
}

func TestHealthColor(t *testing.T) {
	tests := []struct {
		name   string
		health string
	}{
		{"healthy", "healthy"},
		{"unhealthy", "unhealthy"},
		{"none", "none"},
		{"starting", "starting"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := HealthColor(tt.health)
			assert.NotEmpty(t, result)
			assert.Contains(t, result, tt.health)
		})
	}
}

func TestFormatPercent(t *testing.T) {
	tests := []struct {
		name  string
		value float64
	}{
		{"low", 5.0},
		{"medium", 50.0},
		{"high", 75.0},
		{"critical", 95.0},
		{"zero", 0.0},
		{"exact hundred", 100.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := FormatPercent(tt.value)
			assert.NotEmpty(t, result)
			assert.Contains(t, result, "%")
		})
	}
}

func TestFormatPercentValue(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  string
	}{
		{"single digit", 5.0, " 05%"},
		{"double digit", 50.0, "50%"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatPercentValue(tt.value)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestFormatUptime(t *testing.T) {
	tests := []struct {
		name    string
		seconds int64
		want    string
	}{
		{"less than a minute", 30, "< 1 min"},
		{"one minute", 60, "< 1 min"}, // 60/60 = 1, but <= 1 returns "< 1 min"
		{"several minutes", 300, "5 mins"},
		{"one hour", 3600, "1 hour"},
		{"several hours", 7200, "2 hours"},
		{"one day", 86400, "1 day"},
		{"several days", 259200, "3 days"},
		{"zero", 0, "< 1 min"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := FormatUptime(tt.seconds)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestFormatBytes(t *testing.T) {
	tests := []struct {
		name string
		mb   int64
		want string
	}{
		{"megabytes", 512, "512 MB"},
		{"gigabytes", 2048, "2.0 GB"},
		{"one mb", 1, "1 MB"},
		{"just under 1 GB", 1023, "1023 MB"},
		{"exactly 1 GB", 1024, "1.0 GB"},
		{"large", 8192, "8.0 GB"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := FormatBytes(tt.mb)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestNewTable(t *testing.T) {
	headers := []string{"NAME", "STATUS", "CPU"}
	table := NewTable(headers)
	assert.NotNil(t, table)
}

func TestDisableColors(t *testing.T) {
	// Just verify it doesn't panic
	DisableColors()
}

func TestColorFunctions(t *testing.T) {
	// Test that color functions return non-empty strings
	assert.NotEmpty(t, Green("test"))
	assert.NotEmpty(t, Yellow("test"))
	assert.NotEmpty(t, Red("test"))
	assert.NotEmpty(t, Cyan("test"))
	assert.NotEmpty(t, Bold("test"))
}

func TestFormatFloat(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  string
	}{
		{"integer value", 50.0, "50"},
		{"decimal value", 5.5, "05.5"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatFloat(tt.value)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestFormatInt64(t *testing.T) {
	tests := []struct {
		name  string
		value int64
		want  string
	}{
		{"single digit", 5, "5"},
		{"double digit", 42, "42"},
		{"triple digit", 100, "100"},
		{"large number", 12345, "12345"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatInt64(tt.value)
			assert.Equal(t, tt.want, result)
		})
	}
}
