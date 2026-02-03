package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
)

const (
	DefaultURL        = "http://localhost:3000"
	ConfigDir         = ".bridgeport"
	ConfigFileName    = "config"
	ConfigFileType    = "yaml"
	EnvPrefix         = "BRIDGEPORT"
	TokenEnvVar       = "BRIDGEPORT_TOKEN"
)

type Config struct {
	URL                string `mapstructure:"url"`
	Token              string `mapstructure:"token"`
	DefaultEnvironment string `mapstructure:"default_environment"`
}

var cfg *Config

// Load reads configuration from file, environment, and flags
func Load() (*Config, error) {
	if cfg != nil {
		return cfg, nil
	}

	v := viper.New()

	// Set defaults
	v.SetDefault("url", DefaultURL)

	// Config file location
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	configPath := filepath.Join(homeDir, ConfigDir)
	v.AddConfigPath(configPath)
	v.SetConfigName(ConfigFileName)
	v.SetConfigType(ConfigFileType)

	// Environment variables
	v.SetEnvPrefix(EnvPrefix)
	v.AutomaticEnv()

	// Read config file (ignore if not found)
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("failed to read config: %w", err)
		}
	}

	// Check for token in environment variable
	if token := os.Getenv(TokenEnvVar); token != "" {
		v.Set("token", token)
	}

	cfg = &Config{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	return cfg, nil
}

// GetConfigPath returns the full path to the config file
func GetConfigPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ConfigDir, ConfigFileName+"."+ConfigFileType), nil
}

// Save writes the config to the config file
func Save(c *Config) error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	configPath := filepath.Join(homeDir, ConfigDir)
	if err := os.MkdirAll(configPath, 0700); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	v := viper.New()
	v.Set("url", c.URL)
	v.Set("token", c.Token)
	if c.DefaultEnvironment != "" {
		v.Set("default_environment", c.DefaultEnvironment)
	}

	configFile := filepath.Join(configPath, ConfigFileName+"."+ConfigFileType)
	if err := v.WriteConfigAs(configFile); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Secure the config file
	if err := os.Chmod(configFile, 0600); err != nil {
		return fmt.Errorf("failed to set config permissions: %w", err)
	}

	cfg = c
	return nil
}

// IsAuthenticated checks if we have a valid token
func (c *Config) IsAuthenticated() bool {
	return c.Token != ""
}

// GetToken returns the token, checking environment variable first
func GetToken() string {
	if token := os.Getenv(TokenEnvVar); token != "" {
		return token
	}
	if cfg != nil {
		return cfg.Token
	}
	return ""
}
