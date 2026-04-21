package cmd

import (
	"fmt"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var backupsCmd = &cobra.Command{
	Use:   "backups <environment> <database>",
	Short: "List database backups",
	Long: `List recent backups for a database.

Examples:
  bridgeport backups staging mydb            # List backups
  bridgeport backups staging mydb --limit 10 # Last 10 backups`,
	Args: cobra.ExactArgs(2),
	RunE: runBackups,
}

var backupsLimit int

func init() {
	rootCmd.AddCommand(backupsCmd)
	backupsCmd.Flags().IntVar(&backupsLimit, "limit", 20, "Number of backups to show")
}

func runBackups(cmd *cobra.Command, args []string) error {
	envName := args[0]
	dbName := args[1]

	client := getClient()

	env, err := client.GetEnvironmentByName(envName)
	if err != nil {
		return err
	}

	db, err := client.GetDatabaseByName(env.ID, dbName)
	if err != nil {
		return err
	}

	backups, err := client.ListDatabaseBackups(db.ID, backupsLimit)
	if err != nil {
		return fmt.Errorf("failed to list backups: %w", err)
	}

	if len(backups) == 0 {
		fmt.Printf("No backups found for %s\n", dbName)
		return nil
	}

	fmt.Printf("%s %s (%s)\n\n", output.Bold("Database:"), dbName, db.Type)

	table := output.NewTable([]string{"STATUS", "TYPE", "FILENAME", "SIZE", "DURATION", "CREATED"})

	for _, b := range backups {
		size := formatFileSize(b.Size)

		duration := "-"
		if b.Duration != nil {
			duration = fmt.Sprintf("%ds", *b.Duration)
		}

		table.Append([]string{
			output.StatusColor(b.Status),
			b.Type,
			b.Filename,
			size,
			duration,
			formatTimestamp(b.CreatedAt),
		})
	}

	table.Render()
	return nil
}

func formatFileSize(bytes int64) string {
	if bytes == 0 {
		return "-"
	}
	const (
		kb = 1024
		mb = 1024 * kb
		gb = 1024 * mb
	)
	switch {
	case bytes >= gb:
		return fmt.Sprintf("%.1f GB", float64(bytes)/float64(gb))
	case bytes >= mb:
		return fmt.Sprintf("%.1f MB", float64(bytes)/float64(mb))
	case bytes >= kb:
		return fmt.Sprintf("%.1f KB", float64(bytes)/float64(kb))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

func formatTimestamp(ts string) string {
	// Return the first 19 chars (YYYY-MM-DDTHH:MM:SS) for readable output
	if len(ts) >= 19 {
		return ts[:10] + " " + ts[11:19]
	}
	return ts
}
