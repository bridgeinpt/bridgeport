package cmd

import (
	"fmt"
	"strconv"

	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var healthCmd = &cobra.Command{
	Use:   "health <environment>",
	Short: "Show health check logs",
	Long: `Display health check logs for an environment with optional filters.

Examples:
  bridgeport health staging                      # All health logs
  bridgeport health staging --status failure      # Only failures
  bridgeport health staging --type server         # Server checks only
  bridgeport health staging --hours 48            # Last 48 hours`,
	Args: cobra.ExactArgs(1),
	RunE: runHealth,
}

var (
	healthStatus string
	healthType   string
	healthHours  int
	healthLimit  int
)

func init() {
	rootCmd.AddCommand(healthCmd)
	healthCmd.Flags().StringVar(&healthStatus, "status", "", "Filter by status (success, failure, timeout)")
	healthCmd.Flags().StringVar(&healthType, "type", "", "Filter by type (server, service, container)")
	healthCmd.Flags().IntVar(&healthHours, "hours", 24, "Time range in hours (default 24)")
	healthCmd.Flags().IntVar(&healthLimit, "limit", 50, "Number of logs to show")
}

func runHealth(cmd *cobra.Command, args []string) error {
	envName := args[0]

	client := getClient()

	env, err := client.GetEnvironmentByName(envName)
	if err != nil {
		return err
	}

	params := map[string]string{
		"hours": strconv.Itoa(healthHours),
		"limit": strconv.Itoa(healthLimit),
	}
	if healthStatus != "" {
		params["status"] = healthStatus
	}
	if healthType != "" {
		params["type"] = healthType
	}

	resp, err := client.ListHealthLogs(env.ID, params)
	if err != nil {
		return fmt.Errorf("failed to list health logs: %w", err)
	}

	if len(resp.Logs) == 0 {
		fmt.Println("No health logs found")
		return nil
	}

	fmt.Printf("Showing %d of %d logs (last %d hours)\n\n", len(resp.Logs), resp.Total, healthHours)

	table := output.NewTable([]string{"TIME", "TYPE", "RESOURCE", "CHECK", "STATUS", "DURATION"})

	for _, log := range resp.Logs {
		duration := "-"
		if log.DurationMs != nil {
			duration = fmt.Sprintf("%dms", *log.DurationMs)
		}

		table.Append([]string{
			formatTimestamp(log.CreatedAt),
			log.ResourceType,
			log.ResourceName,
			log.CheckType,
			output.StatusColor(log.Status),
			duration,
		})
	}

	table.Render()
	return nil
}
