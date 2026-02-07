package cmd

import (
	"fmt"

	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show current user information",
	Long: `Display information about the currently authenticated user.

Example:
  bridgeport whoami`,
	RunE: runWhoami,
}

func init() {
	rootCmd.AddCommand(whoamiCmd)
}

func runWhoami(cmd *cobra.Command, args []string) error {
	client := getClient()

	user, err := client.GetCurrentUser()
	if err != nil {
		return fmt.Errorf("failed to get user info: %w", err)
	}

	name := user.Email
	if user.Name != nil && *user.Name != "" {
		name = *user.Name
	}

	fmt.Printf("%s %s\n", output.Bold("User:"), name)
	fmt.Printf("%s %s\n", output.Bold("Email:"), user.Email)
	fmt.Printf("%s %s\n", output.Bold("Role:"), user.Role)
	fmt.Printf("%s %s\n", output.Bold("URL:"), getConfig().URL)

	return nil
}
