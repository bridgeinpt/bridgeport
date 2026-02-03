package cmd

import (
	"fmt"

	"github.com/bridgein/bridgeport-cli/internal/docker"
	"github.com/spf13/cobra"
)

var execCmd = &cobra.Command{
	Use:   "exec <environment> <server> <service> [-- command]",
	Short: "Execute a command in a container",
	Long: `Open an interactive shell or run a command inside a container.

Examples:
  bridgeport exec staging app-api app-api              # Default shell (/bin/sh)
  bridgeport exec staging app-api app-api --shell bash # Use bash
  bridgeport exec staging app-api app-api -- ls -la    # Run a command`,
	Args: cobra.MinimumNArgs(3),
	RunE: runExec,
}

var execShell string

func init() {
	rootCmd.AddCommand(execCmd)
	execCmd.Flags().StringVar(&execShell, "shell", "", "Shell to use (default: /bin/sh)")
}

func runExec(cmd *cobra.Command, args []string) error {
	envName := args[0]
	serverName := args[1]
	serviceName := args[2]

	// Any remaining args after -- are the command
	var command []string
	if cmd.ArgsLenAtDash() >= 0 {
		command = args[3+cmd.ArgsLenAtDash()-2:]
	}

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
		if len(command) > 0 {
			fmt.Printf("Running command in %s on %s...\n", serviceName, host)
		} else {
			fmt.Printf("Opening shell in %s on %s...\n", serviceName, host)
		}
	}

	return docker.Exec(creds.PrivateKey, creds.Username, host, docker.ExecOptions{
		Container:   serviceName,
		Command:     command,
		Interactive: true,
		TTY:         true,
		Shell:       execShell,
	})
}
