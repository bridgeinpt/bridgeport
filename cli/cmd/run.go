package cmd

import (
	"fmt"

	"github.com/bridgein/bridgeport-cli/internal/api"
	"github.com/bridgein/bridgeport-cli/internal/docker"
	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var runCmd = &cobra.Command{
	Use:   "run <environment> <server> <service> <command>",
	Short: "Run a predefined command",
	Long: `Run a predefined command from the service's type configuration.

Use --list to see available commands for a service.

Examples:
  bridgeport run staging app-api app-api --list  # List available commands
  bridgeport run staging app-api app-api shell   # Run Django shell
  bridgeport run staging app-api app-api migrate # Run migrations`,
	Args: cobra.MinimumNArgs(3),
	RunE: runRun,
}

var runList bool

func init() {
	rootCmd.AddCommand(runCmd)
	runCmd.Flags().BoolVar(&runList, "list", false, "List available commands for the service")
}

func runRun(cmd *cobra.Command, args []string) error {
	envName := args[0]
	serverName := args[1]
	serviceName := args[2]

	client := getClient()

	// Find server
	server, err := client.GetServerByEnvAndName(envName, serverName)
	if err != nil {
		return err
	}

	// Find service
	service, err := client.GetServiceByName(server.ID, serviceName)
	if err != nil {
		return err
	}

	// If --list, show available commands
	if runList {
		return listCommands(service)
	}

	// Otherwise, need command name
	if len(args) < 4 {
		return fmt.Errorf("command name required. Use --list to see available commands")
	}
	commandName := args[3]

	// Get the actual command to run
	commandStr, err := client.GetRunCommand(service.ID, commandName)
	if err != nil {
		return fmt.Errorf("failed to get command: %w", err)
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
		fmt.Printf("Running '%s' in %s on %s...\n", commandStr, serviceName, host)
	}

	return docker.Exec(creds.PrivateKey, creds.Username, host, docker.ExecOptions{
		Container:   serviceName,
		Command:     []string{commandStr},
		Interactive: true,
		TTY:         true,
	})
}

func listCommands(service *api.Service) error {
	if service.ServiceType == nil || len(service.ServiceType.Commands) == 0 {
		fmt.Printf("No predefined commands available for %s\n", service.Name)
		if service.ServiceType == nil {
			fmt.Println("Tip: Assign a service type in BridgePort to enable predefined commands")
		}
		return nil
	}

	fmt.Printf("Available commands for %s (%s):\n\n", service.Name, service.ServiceType.DisplayName)

	for _, cmd := range service.ServiceType.Commands {
		fmt.Printf("  %s\n", output.Bold(cmd.Name))
		if cmd.Description != "" {
			fmt.Printf("    %s\n", cmd.Description)
		}
		fmt.Printf("    Command: %s\n\n", output.Cyan(cmd.Command))
	}

	return nil
}
