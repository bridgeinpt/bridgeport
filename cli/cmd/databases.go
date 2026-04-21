package cmd

import (
	"fmt"
	"strconv"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var databasesCmd = &cobra.Command{
	Use:   "databases [--env environment]",
	Short: "List databases",
	Long: `List all databases with their type, monitoring status, and backup settings.

Examples:
  bridgeport databases              # List all databases
  bridgeport databases --env staging # List databases in staging`,
	RunE: runDatabases,
}

var databasesEnv string

func init() {
	rootCmd.AddCommand(databasesCmd)
	databasesCmd.Flags().StringVar(&databasesEnv, "env", "", "Filter by environment name")
}

func runDatabases(cmd *cobra.Command, args []string) error {
	client := getClient()

	envs, err := client.ListEnvironments()
	if err != nil {
		return fmt.Errorf("failed to list environments: %w", err)
	}

	envMap := make(map[string]string)
	var targetEnvIDs []string
	for _, env := range envs {
		envMap[env.ID] = env.Name
		if databasesEnv == "" || env.Name == databasesEnv {
			targetEnvIDs = append(targetEnvIDs, env.ID)
		}
	}

	if databasesEnv != "" && len(targetEnvIDs) == 0 {
		return fmt.Errorf("environment '%s' not found", databasesEnv)
	}

	table := output.NewTable([]string{"ENV", "NAME", "TYPE", "HOST", "MONITORING", "BACKUP"})
	count := 0

	for _, envID := range targetEnvIDs {
		databases, err := client.ListDatabases(envID)
		if err != nil {
			continue
		}

		for _, db := range databases {
			host := "-"
			if db.Host != nil && *db.Host != "" {
				host = *db.Host
				if db.Port != nil {
					host += ":" + strconv.Itoa(*db.Port)
				}
			}

			monitoring := output.StatusColor("disabled")
			if db.MonitoringEnabled {
				monitoring = output.StatusColor(db.MonitoringStatus)
			}

			table.Append([]string{
				envMap[db.EnvironmentID],
				db.Name,
				db.Type,
				host,
				monitoring,
				db.BackupStorageType,
			})
			count++
		}
	}

	if count == 0 {
		fmt.Println("No databases found")
		return nil
	}

	table.Render()
	return nil
}
