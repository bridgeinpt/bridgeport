package cmd

import (
	"fmt"

	"github.com/bridgeinpt/bridgeport-cli/internal/ssh"
	"github.com/spf13/cobra"
)

var sshCmd = &cobra.Command{
	Use:   "ssh <environment> <server> [-- command]",
	Short: "SSH into a server",
	Long: `Open an SSH session to a server, optionally running a command.

Examples:
  bridgeport ssh staging app-api           # Interactive shell
  bridgeport ssh staging app-api -- ls -la # Run a command`,
	Args: cobra.MinimumNArgs(2),
	RunE: runSSH,
}

func init() {
	rootCmd.AddCommand(sshCmd)
}

func runSSH(cmd *cobra.Command, args []string) error {
	envName := args[0]
	serverName := args[1]

	// Any remaining args after -- are the command
	var command []string
	if cmd.ArgsLenAtDash() >= 0 {
		command = args[cmd.ArgsLenAtDash():]
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

	// Determine host - prefer public IP if available, otherwise private
	host := server.PrivateIP
	if server.PublicIP != nil && *server.PublicIP != "" {
		host = *server.PublicIP
	}

	if verbose {
		fmt.Printf("Connecting to %s@%s...\n", creds.Username, host)
	}

	// Connect
	return ssh.Connect(creds.PrivateKey, creds.Username, host, command)
}
