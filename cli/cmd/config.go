package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/bridgein/bridgeport-cli/internal/config"
	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Configure BRIDGEPORT CLI settings",
	Long: `Interactively configure BRIDGEPORT CLI settings.

For each setting, enter a new value or press Enter to keep the current value.
Settings are saved to ~/.bridgeport/config.yaml

Examples:
  bridgeport config           # Interactive configuration
  bridgeport config --show    # Show current configuration
  bridgeport config --path    # Show config file path`,
	RunE: runConfig,
}

var (
	configShow bool
	configPath bool
)

func init() {
	rootCmd.AddCommand(configCmd)
	configCmd.Flags().BoolVar(&configShow, "show", false, "Show current configuration")
	configCmd.Flags().BoolVar(&configPath, "path", false, "Show config file path")
}

func runConfig(cmd *cobra.Command, args []string) error {
	// Load current config
	cfg, err := config.Load()
	if err != nil {
		// If config doesn't exist, start with defaults
		cfg = &config.Config{
			URL: config.DefaultURL,
		}
	}

	// Show config path only
	if configPath {
		path, err := config.GetConfigPath()
		if err != nil {
			return err
		}
		fmt.Println(path)
		return nil
	}

	// Show current config only
	if configShow {
		fmt.Println("Current configuration:")
		fmt.Println()
		fmt.Printf("  %-20s %s\n", "Server URL:", valueOrDefault(cfg.URL, "(not set)"))
		fmt.Printf("  %-20s %s\n", "Token:", maskToken(cfg.Token))
		fmt.Printf("  %-20s %s\n", "Default Environment:", valueOrDefault(cfg.DefaultEnvironment, "(not set)"))
		fmt.Println()
		path, _ := config.GetConfigPath()
		fmt.Printf("Config file: %s\n", path)
		return nil
	}

	// Interactive configuration
	reader := bufio.NewReader(os.Stdin)

	fmt.Println("BRIDGEPORT CLI Configuration")
	fmt.Println("Press Enter to keep current value, or type a new value.")
	fmt.Println()

	// Server URL
	fmt.Printf("Server URL [%s]: ", valueOrDefault(cfg.URL, config.DefaultURL))
	input, err := reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("failed to read input: %w", err)
	}
	input = strings.TrimSpace(input)
	if input != "" {
		cfg.URL = input
	} else if cfg.URL == "" {
		cfg.URL = config.DefaultURL
	}

	// Token
	currentToken := "(not set)"
	if cfg.Token != "" {
		currentToken = maskToken(cfg.Token)
	}
	fmt.Printf("API Token [%s]: ", currentToken)
	input, err = reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("failed to read input: %w", err)
	}
	input = strings.TrimSpace(input)
	if input != "" {
		cfg.Token = input
	}

	// Default environment
	fmt.Printf("Default Environment [%s]: ", valueOrDefault(cfg.DefaultEnvironment, "(none)"))
	input, err = reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("failed to read input: %w", err)
	}
	input = strings.TrimSpace(input)
	if input != "" {
		cfg.DefaultEnvironment = input
	}

	// Save config
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	fmt.Println()
	fmt.Printf("%s Configuration saved\n", output.Green("✓"))
	path, _ := config.GetConfigPath()
	fmt.Printf("Config file: %s\n", path)

	return nil
}

func valueOrDefault(value, defaultValue string) string {
	if value == "" {
		return defaultValue
	}
	return value
}

func maskToken(token string) string {
	if token == "" {
		return "(not set)"
	}
	if len(token) <= 8 {
		return "****"
	}
	return token[:4] + "..." + token[len(token)-4:]
}
