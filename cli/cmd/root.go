package cmd

import (
	"fmt"
	"os"

	"github.com/bridgeinpt/bridgeport-cli/internal/api"
	"github.com/bridgeinpt/bridgeport-cli/internal/config"
	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var (
	cfgFile   string
	serverURL string
	token     string
	noColor   bool
	verbose   bool

	cfg       *config.Config
	apiClient *api.Client
)

// Version is set at build time
var Version = "dev"

var rootCmd = &cobra.Command{
	Use:   "bridgeport",
	Short: "BRIDGEPORT CLI - Manage your infrastructure",
	Long: `BRIDGEPORT CLI provides SSH access, server management, and deployment
tools for your BRIDGEPORT-managed infrastructure.

Get started:
  bridgeport login            # Authenticate with BRIDGEPORT
  bridgeport whoami           # Show current user info
  bridgeport list             # List all servers
  bridgeport services         # List all services
  bridgeport ssh env server   # SSH into a server
  bridgeport databases        # List databases
  bridgeport health env       # View health check logs
  bridgeport audit            # View audit logs`,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		// Skip auth check for login, config, help, version, and completion commands
		skipAuth := cmd.Name() == "login" || cmd.Name() == "config" || cmd.Name() == "help" || cmd.Name() == "version" || cmd.Name() == "completion"
		if cmd.Parent() != nil && cmd.Parent().Name() == "completion" {
			skipAuth = true
		}

		if noColor {
			output.DisableColors()
		}

		var err error
		cfg, err = config.Load()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		// Override config with flags
		if serverURL != "" {
			cfg.URL = serverURL
		}
		if token != "" {
			cfg.Token = token
		}

		// Create API client
		apiClient = api.NewClient(cfg.URL, cfg.Token)

		// Check authentication if required
		if !skipAuth && !cfg.IsAuthenticated() {
			return fmt.Errorf("not authenticated. Run 'bridgeport login' first")
		}

		return nil
	},
	SilenceUsage:  true,
	SilenceErrors: true,
}

func Execute() error {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, output.Red("Error:"), err)
		return err
	}
	return nil
}

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default: ~/.bridgeport/config.yaml)")
	rootCmd.PersistentFlags().StringVar(&serverURL, "url", "", "BRIDGEPORT server URL (default: localhost:3000)")
	rootCmd.PersistentFlags().StringVar(&token, "token", "", "API token (overrides config)")
	rootCmd.PersistentFlags().BoolVar(&noColor, "no-color", false, "Disable colored output")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Verbose output")
}

// getClient returns the configured API client
func getClient() *api.Client {
	return apiClient
}

// getConfig returns the loaded configuration
func getConfig() *config.Config {
	return cfg
}
