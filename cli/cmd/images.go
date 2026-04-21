package cmd

import (
	"fmt"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var imagesCmd = &cobra.Command{
	Use:   "images <environment>",
	Short: "List container images",
	Long: `List all container images tracked in an environment.

Example:
  bridgeport images staging`,
	Args: cobra.ExactArgs(1),
	RunE: runImages,
}

func init() {
	rootCmd.AddCommand(imagesCmd)
}

func runImages(cmd *cobra.Command, args []string) error {
	envName := args[0]

	client := getClient()

	env, err := client.GetEnvironmentByName(envName)
	if err != nil {
		return err
	}

	images, err := client.ListContainerImages(env.ID)
	if err != nil {
		return fmt.Errorf("failed to list images: %w", err)
	}

	if len(images) == 0 {
		fmt.Println("No container images found")
		return nil
	}

	table := output.NewTable([]string{"NAME", "IMAGE", "CURRENT", "LATEST", "AUTO-UPDATE"})

	for _, img := range images {
		latest := "-"
		if img.LatestTag != nil && *img.LatestTag != "" {
			latest = *img.LatestTag
			if latest != img.CurrentTag {
				latest = output.Yellow(latest)
			}
		}

		autoUpdate := ""
		if img.AutoUpdate {
			autoUpdate = output.Green("yes")
		}

		table.Append([]string{
			img.Name,
			img.ImageName,
			img.CurrentTag,
			latest,
			autoUpdate,
		})
	}

	table.Render()
	return nil
}
