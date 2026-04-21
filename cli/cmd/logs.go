package cmd

import (
	"fmt"

	"github.com/bridgeinpt/bridgeport-cli/internal/docker"
	"github.com/spf13/cobra"
)

var logsCmd = &cobra.Command{
	Use:   "logs <environment> <server> <service>",
	Short: "View container logs",
	Long: `View logs from a container running on a server.

Examples:
  bridgeport logs staging app-api app-api           # View logs
  bridgeport logs staging app-api app-api -f        # Stream logs
  bridgeport logs staging app-api app-api --tail 50 # Last 50 lines`,
	Args: cobra.ExactArgs(3),
	RunE: runLogs,
}

var (
	logsFollow bool
	logsTail   int
)

func init() {
	rootCmd.AddCommand(logsCmd)
	logsCmd.Flags().BoolVarP(&logsFollow, "follow", "f", false, "Stream logs in real-time")
	logsCmd.Flags().IntVar(&logsTail, "tail", 100, "Number of lines to show (default 100)")
}

func runLogs(cmd *cobra.Command, args []string) error {
	envName := args[0]
	serverName := args[1]
	serviceName := args[2]

	client := getClient()

	// Find server
	server, err := client.GetServerByEnvAndName(envName, serverName)
	if err != nil {
		return err
	}

	// Get SSH credentials
	creds, err := client.GetSSHKey(server.EnvironmentID)
	if err != nil {
		return fmt.Errorf("failed to get SSH key: %w", err)
	}

	// Determine host
	host := server.PrivateIP
	if server.PublicIP != nil && *server.PublicIP != "" {
		host = *server.PublicIP
	}

	if verbose {
		fmt.Printf("Streaming logs from %s on %s...\n", serviceName, host)
	}

	return docker.Logs(creds.PrivateKey, creds.Username, host, serviceName, logsFollow, logsTail)
}
