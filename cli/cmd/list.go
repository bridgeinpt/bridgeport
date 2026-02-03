package cmd

import (
	"fmt"
	"strconv"

	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:   "list [--env environment]",
	Short: "List servers with status and metrics",
	Long: `List all servers with their status, metrics, and service count.

Examples:
  bridgeport list              # List all servers
  bridgeport list --env staging # List servers in staging only`,
	RunE: runList,
}

var listEnv string

func init() {
	rootCmd.AddCommand(listCmd)
	listCmd.Flags().StringVar(&listEnv, "env", "", "Filter by environment name")
}

func runList(cmd *cobra.Command, args []string) error {
	client := getClient()

	// Get environments to map IDs to names
	envs, err := client.ListEnvironments()
	if err != nil {
		return fmt.Errorf("failed to list environments: %w", err)
	}

	envMap := make(map[string]string)
	var filterEnvID string
	for _, env := range envs {
		envMap[env.ID] = env.Name
		if listEnv != "" && env.Name == listEnv {
			filterEnvID = env.ID
		}
	}

	if listEnv != "" && filterEnvID == "" {
		return fmt.Errorf("environment '%s' not found", listEnv)
	}

	// Get servers
	servers, err := client.ListServers(filterEnvID)
	if err != nil {
		return fmt.Errorf("failed to list servers: %w", err)
	}

	if len(servers) == 0 {
		fmt.Println("No servers found")
		return nil
	}

	// Get services to count per server
	services, err := client.ListServices("")
	if err != nil {
		return fmt.Errorf("failed to list services: %w", err)
	}

	serviceCount := make(map[string]int)
	for _, svc := range services {
		serviceCount[svc.ServerID]++
	}

	// Build table
	table := output.NewTable([]string{"ENV", "SERVER", "IP", "STATUS", "CPU", "MEM", "SERVICES"})

	for _, server := range servers {
		envName := envMap[server.EnvironmentID]

		ip := server.PrivateIP
		if server.PublicIP != nil && *server.PublicIP != "" {
			ip = *server.PublicIP
		}

		status := output.StatusColor(server.Status)

		var cpu, mem string
		if server.Metrics != nil {
			cpu = output.FormatPercent(server.Metrics.CPUPercent)
			mem = output.FormatPercent(server.Metrics.MemoryPercent)
		} else {
			cpu = "-"
			mem = "-"
		}

		svcCount := strconv.Itoa(serviceCount[server.ID])

		table.Append([]string{envName, server.Name, ip, status, cpu, mem, svcCount})
	}

	table.Render()
	return nil
}
