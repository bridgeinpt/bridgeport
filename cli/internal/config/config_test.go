package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigDefaults(t *testing.T) {
	assert.Equal(t, "http://localhost:3000", DefaultURL)
	assert.Equal(t, ".bridgeport", ConfigDir)
	assert.Equal(t, "config", ConfigFileName)
	assert.Equal(t, "yaml", ConfigFileType)
	assert.Equal(t, "BRIDGEPORT", EnvPrefix)
	assert.Equal(t, "BRIDGEPORT_TOKEN", TokenEnvVar)
}

func TestIsAuthenticated(t *testing.T) {
	tests := []struct {
		name  string
		token string
		want  bool
	}{
		{"with token", "some-token", true},
		{"empty token", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &Config{Token: tt.token}
			assert.Equal(t, tt.want, c.IsAuthenticated())
		})
	}
}

func TestGetToken(t *testing.T) {
	// Reset global state
	cfg = nil

	// Test from environment variable
	os.Setenv(TokenEnvVar, "env-token")
	defer os.Unsetenv(TokenEnvVar)

	token := GetToken()
	assert.Equal(t, "env-token", token)

	// Test from config when env var is cleared
	os.Unsetenv(TokenEnvVar)
	cfg = &Config{Token: "config-token"}
	token = GetToken()
	assert.Equal(t, "config-token", token)

	// Cleanup
	cfg = nil
}

func TestGetTokenNoSource(t *testing.T) {
	cfg = nil
	os.Unsetenv(TokenEnvVar)

	token := GetToken()
	assert.Empty(t, token)
}

func TestGetConfigPath(t *testing.T) {
	path, err := GetConfigPath()
	require.NoError(t, err)

	homeDir, _ := os.UserHomeDir()
	expected := filepath.Join(homeDir, ".bridgeport", "config.yaml")
	assert.Equal(t, expected, path)
}

func TestSaveAndLoad(t *testing.T) {
	// Use a temporary directory as home
	tmpDir := t.TempDir()
	origHome := os.Getenv("HOME")
	os.Setenv("HOME", tmpDir)
	defer os.Setenv("HOME", origHome)

	// Reset cached config
	cfg = nil

	c := &Config{
		URL:                "https://deploy.example.com",
		Token:              "test-token-123",
		DefaultEnvironment: "staging",
	}

	err := Save(c)
	require.NoError(t, err)

	// Verify file exists with correct permissions
	configFile := filepath.Join(tmpDir, ".bridgeport", "config.yaml")
	info, err := os.Stat(configFile)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0600), info.Mode().Perm())

	// Reset cached config to force re-read
	cfg = nil

	loaded, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "https://deploy.example.com", loaded.URL)
	assert.Equal(t, "test-token-123", loaded.Token)
	assert.Equal(t, "staging", loaded.DefaultEnvironment)

	// Cleanup
	cfg = nil
}

func TestLoadDefaultsWhenNoFile(t *testing.T) {
	tmpDir := t.TempDir()
	origHome := os.Getenv("HOME")
	os.Setenv("HOME", tmpDir)
	defer os.Setenv("HOME", origHome)

	cfg = nil

	loaded, err := Load()
	require.NoError(t, err)
	assert.Equal(t, DefaultURL, loaded.URL)
	assert.Empty(t, loaded.Token)

	cfg = nil
}

func TestLoadCachedConfig(t *testing.T) {
	// Set a cached config
	cfg = &Config{
		URL:   "https://cached.example.com",
		Token: "cached-token",
	}

	loaded, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "https://cached.example.com", loaded.URL)

	// Cleanup
	cfg = nil
}

func TestSaveCreatesDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	origHome := os.Getenv("HOME")
	os.Setenv("HOME", tmpDir)
	defer os.Setenv("HOME", origHome)

	cfg = nil

	// Directory shouldn't exist yet
	configDir := filepath.Join(tmpDir, ".bridgeport")
	_, err := os.Stat(configDir)
	assert.True(t, os.IsNotExist(err))

	// Save should create it
	err = Save(&Config{URL: "https://test.com"})
	require.NoError(t, err)

	info, err := os.Stat(configDir)
	require.NoError(t, err)
	assert.True(t, info.IsDir())

	cfg = nil
}

func TestSaveWithoutDefaultEnvironment(t *testing.T) {
	tmpDir := t.TempDir()
	origHome := os.Getenv("HOME")
	os.Setenv("HOME", tmpDir)
	defer os.Setenv("HOME", origHome)

	cfg = nil

	c := &Config{
		URL:   "https://test.com",
		Token: "token",
		// DefaultEnvironment is empty
	}

	err := Save(c)
	require.NoError(t, err)

	cfg = nil
}

func TestConfigStruct(t *testing.T) {
	c := Config{
		URL:                "https://deploy.example.com",
		Token:              "jwt-token-here",
		DefaultEnvironment: "production",
	}

	assert.Equal(t, "https://deploy.example.com", c.URL)
	assert.Equal(t, "jwt-token-here", c.Token)
	assert.Equal(t, "production", c.DefaultEnvironment)
	assert.True(t, c.IsAuthenticated())
}
