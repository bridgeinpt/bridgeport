package cmd

import (
	"fmt"
	"strconv"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var registriesCmd = &cobra.Command{
	Use:   "registries <environment>",
	Short: "List container registries",
	Long: `List all container registries configured in an environment.

Example:
  bridgeport registries staging`,
	Args: cobra.ExactArgs(1),
	RunE: runRegistries,
}

func init() {
	rootCmd.AddCommand(registriesCmd)
}

func runRegistries(cmd *cobra.Command, args []string) error {
	envName := args[0]

	client := getClient()

	env, err := client.GetEnvironmentByName(envName)
	if err != nil {
		return err
	}

	registries, err := client.ListRegistries(env.ID)
	if err != nil {
		return fmt.Errorf("failed to list registries: %w", err)
	}

	if len(registries) == 0 {
		fmt.Println("No registries found")
		return nil
	}

	table := output.NewTable([]string{"NAME", "TYPE", "URL", "IMAGES", "DEFAULT"})

	for _, r := range registries {
		def := ""
		if r.IsDefault {
			def = output.Green("yes")
		}

		table.Append([]string{
			r.Name,
			r.Type,
			r.RegistryURL,
			strconv.Itoa(r.ImageCount),
			def,
		})
	}

	table.Render()
	return nil
}
