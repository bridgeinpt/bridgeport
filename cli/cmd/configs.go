package cmd

import (
	"fmt"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var configsCmd = &cobra.Command{
	Use:   "configs <environment>",
	Short: "List config files",
	Long: `List all config files in an environment with their sync status.

Example:
  bridgeport configs staging`,
	Args: cobra.ExactArgs(1),
	RunE: runConfigs,
}

func init() {
	rootCmd.AddCommand(configsCmd)
}

func runConfigs(cmd *cobra.Command, args []string) error {
	envName := args[0]

	client := getClient()

	env, err := client.GetEnvironmentByName(envName)
	if err != nil {
		return err
	}

	files, err := client.ListConfigFiles(env.ID)
	if err != nil {
		return fmt.Errorf("failed to list config files: %w", err)
	}

	if len(files) == 0 {
		fmt.Println("No config files found")
		return nil
	}

	table := output.NewTable([]string{"NAME", "FILENAME", "SYNC", "SERVICES", "UPDATED"})

	for _, f := range files {
		syncStatus := output.StatusColor(f.SyncStatus)

		services := fmt.Sprintf("%d", f.SyncCounts.Total)
		if f.SyncCounts.Pending > 0 {
			services = fmt.Sprintf("%d (%d pending)", f.SyncCounts.Total, f.SyncCounts.Pending)
		}

		table.Append([]string{
			f.Name,
			f.Filename,
			syncStatus,
			services,
			formatTimestamp(f.UpdatedAt),
		})
	}

	table.Render()
	return nil
}
