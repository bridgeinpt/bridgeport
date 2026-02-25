package cmd

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFormatFileSize(t *testing.T) {
	tests := []struct {
		name  string
		bytes int64
		want  string
	}{
		{"zero bytes", 0, "-"},
		{"small bytes", 500, "500 B"},
		{"kilobytes", 2048, "2.0 KB"},
		{"megabytes", 5242880, "5.0 MB"},
		{"gigabytes", 2147483648, "2.0 GB"},
		{"exact 1 KB", 1024, "1.0 KB"},
		{"exact 1 MB", 1048576, "1.0 MB"},
		{"exact 1 GB", 1073741824, "1.0 GB"},
		{"just under 1 KB", 1023, "1023 B"},
		{"just under 1 MB", 1048575, "1024.0 KB"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatFileSize(tt.bytes)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestFormatTimestamp(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"full ISO timestamp", "2024-01-15T10:30:45.000Z", "2024-01-15 10:30:45"},
		{"short timestamp", "2024-01-15T10:30:45Z", "2024-01-15 10:30:45"},
		{"too short", "2024-01-15", "2024-01-15"},
		{"empty string", "", ""},
		{"exactly 19 chars", "2024-01-15T10:30:45", "2024-01-15 10:30:45"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatTimestamp(tt.input)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestValueOrDefault(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		fallback string
		want     string
	}{
		{"returns value when set", "hello", "default", "hello"},
		{"returns default when empty", "", "default", "default"},
		{"returns value even if whitespace", " ", "default", " "},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := valueOrDefault(tt.value, tt.fallback)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestMaskToken(t *testing.T) {
	tests := []struct {
		name  string
		token string
		want  string
	}{
		{"empty token", "", "(not set)"},
		{"short token", "abc", "****"},
		{"8 char token", "12345678", "****"},
		{"normal token", "eyJhbGciOiJIUzI1NiJ9.token", "eyJh...oken"},
		{"9 char token", "123456789", "1234...6789"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := maskToken(tt.token)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestVersionVariable(t *testing.T) {
	assert.Equal(t, "dev", Version)
}
