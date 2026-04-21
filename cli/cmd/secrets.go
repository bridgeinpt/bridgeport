package cmd

import (
	"fmt"
	"strconv"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var secretsCmd = &cobra.Command{
	Use:   "secrets <environment>",
	Short: "List secret names",
	Long: `List all secrets in an environment (names only, no values).

Example:
  bridgeport secrets staging`,
	Args: cobra.ExactArgs(1),
	RunE: runSecrets,
}

func init() {
	rootCmd.AddCommand(secretsCmd)
}

func runSecrets(cmd *cobra.Command, args []string) error {
	envName := args[0]

	client := getClient()

	env, err := client.GetEnvironmentByName(envName)
	if err != nil {
		return err
	}

	secrets, err := client.ListSecrets(env.ID)
	if err != nil {
		return fmt.Errorf("failed to list secrets: %w", err)
	}

	if len(secrets) == 0 {
		fmt.Println("No secrets found")
		return nil
	}

	table := output.NewTable([]string{"KEY", "DESCRIPTION", "USAGE", "PROTECTED"})

	for _, s := range secrets {
		desc := ""
		if s.Description != nil {
			desc = *s.Description
		}

		protected := ""
		if s.NeverReveal {
			protected = output.Red("yes")
		}

		table.Append([]string{
			s.Key,
			desc,
			strconv.Itoa(s.UsageCount),
			protected,
		})
	}

	table.Render()
	return nil
}
