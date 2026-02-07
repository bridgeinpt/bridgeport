package cmd

import (
	"fmt"
	"strconv"

	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var auditCmd = &cobra.Command{
	Use:   "audit [--env environment]",
	Short: "View audit logs",
	Long: `View audit logs with optional filters.

Examples:
  bridgeport audit                             # All recent audit logs
  bridgeport audit --env staging               # Logs for staging
  bridgeport audit --action deploy             # Only deploy actions
  bridgeport audit --resource-type service     # Only service events
  bridgeport audit --limit 100                 # Last 100 entries`,
	RunE: runAudit,
}

var (
	auditEnv          string
	auditAction       string
	auditResourceType string
	auditLimit        int
)

func init() {
	rootCmd.AddCommand(auditCmd)
	auditCmd.Flags().StringVar(&auditEnv, "env", "", "Filter by environment name")
	auditCmd.Flags().StringVar(&auditAction, "action", "", "Filter by action (deploy, create, update, delete, etc.)")
	auditCmd.Flags().StringVar(&auditResourceType, "resource-type", "", "Filter by resource type (service, server, database, etc.)")
	auditCmd.Flags().IntVar(&auditLimit, "limit", 50, "Number of logs to show")
}

func runAudit(cmd *cobra.Command, args []string) error {
	client := getClient()

	params := map[string]string{
		"limit": strconv.Itoa(auditLimit),
	}

	if auditEnv != "" {
		env, err := client.GetEnvironmentByName(auditEnv)
		if err != nil {
			return err
		}
		params["environmentId"] = env.ID
	}

	if auditAction != "" {
		params["action"] = auditAction
	}
	if auditResourceType != "" {
		params["resourceType"] = auditResourceType
	}

	logs, total, err := client.ListAuditLogs(params)
	if err != nil {
		return fmt.Errorf("failed to list audit logs: %w", err)
	}

	if len(logs) == 0 {
		fmt.Println("No audit logs found")
		return nil
	}

	fmt.Printf("Showing %d of %d logs\n\n", len(logs), total)

	table := output.NewTable([]string{"TIME", "USER", "ACTION", "TYPE", "RESOURCE", "STATUS"})

	for _, log := range logs {
		user := "-"
		if log.User != nil {
			user = log.User.Email
		}

		resource := "-"
		if log.ResourceName != nil {
			resource = *log.ResourceName
		}

		status := output.Green("ok")
		if !log.Success {
			status = output.Red("fail")
		}

		table.Append([]string{
			formatTimestamp(log.CreatedAt),
			user,
			log.Action,
			log.ResourceType,
			resource,
			status,
		})
	}

	table.Render()
	return nil
}
