package cmd

import (
	"fmt"

	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status <environment> <server>",
	Short: "Show detailed server information",
	Long: `Display detailed information about a specific server including
network info, metrics, and running services.

Example:
  bridgeport status staging app-api`,
	Args: cobra.ExactArgs(2),
	RunE: runStatus,
}

func init() {
	rootCmd.AddCommand(statusCmd)
}

func runStatus(cmd *cobra.Command, args []string) error {
	envName := args[0]
	serverName := args[1]

	client := getClient()

	// Find server
	server, err := client.GetServerByEnvAndName(envName, serverName)
	if err != nil {
		return err
	}

	// Get services on this server
	services, err := client.ListServices(server.ID)
	if err != nil {
		return fmt.Errorf("failed to list services: %w", err)
	}

	// Header
	fmt.Printf("%s %s\n", output.Bold("Server:"), server.Name)
	fmt.Printf("%s %s\n", output.Bold("Environment:"), envName)
	fmt.Println()

	// Network
	fmt.Println(output.Bold("Network:"))
	fmt.Printf("  Private IP: %s\n", server.PrivateIP)
	if server.PublicIP != nil && *server.PublicIP != "" {
		fmt.Printf("  Public IP:  %s\n", *server.PublicIP)
	}
	fmt.Println()

	// Metrics
	if server.Metrics != nil {
		m := server.Metrics
		fmt.Printf("%s\n", output.Bold("Metrics:"))
		fmt.Printf("  CPU:    %s\n", output.FormatPercent(m.CPUPercent))
		fmt.Printf("  Memory: %s / %s (%s)\n",
			output.FormatBytes(m.MemoryUsedMB),
			output.FormatBytes(m.MemoryTotalMB),
			output.FormatPercent(m.MemoryPercent))
		fmt.Printf("  Disk:   %.1f GB / %.1f GB (%s)\n",
			m.DiskUsedGB, m.DiskTotalGB,
			output.FormatPercent(m.DiskPercent))
		fmt.Printf("  Uptime: %s\n", output.FormatUptime(m.UptimeSeconds))
		fmt.Println()
	}

	// Services
	if len(services) > 0 {
		fmt.Println(output.Bold("Services:"))
		table := output.NewTable([]string{"NAME", "STATUS", "HEALTH", "IMAGE", "TAG"})

		for _, svc := range services {
			status := output.StatusColor(svc.Status)
			health := output.HealthColor(svc.Health)
			table.Append([]string{svc.Name, status, health, svc.ImageName, svc.ImageTag})
		}

		table.Render()
	} else {
		fmt.Println("No services deployed")
	}

	return nil
}
