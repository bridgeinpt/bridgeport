package cmd

import (
	"fmt"

	"github.com/bridgeinpt/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
)

var servicesCmd = &cobra.Command{
	Use:   "services [--env environment] [--server server]",
	Short: "List services across servers",
	Long: `List all services with their status, health, and image info.

Examples:
  bridgeport services                              # All services
  bridgeport services --env staging                 # Services in staging
  bridgeport services --env staging --server app-01 # Services on a specific server`,
	RunE: runServices,
}

var (
	servicesEnv    string
	servicesServer string
)

func init() {
	rootCmd.AddCommand(servicesCmd)
	servicesCmd.Flags().StringVar(&servicesEnv, "env", "", "Filter by environment name")
	servicesCmd.Flags().StringVar(&servicesServer, "server", "", "Filter by server name (requires --env)")
}

func runServices(cmd *cobra.Command, args []string) error {
	client := getClient()

	// If server is specified, require env
	if servicesServer != "" && servicesEnv == "" {
		return fmt.Errorf("--server requires --env to be specified")
	}

	// Build environment map
	envs, err := client.ListEnvironments()
	if err != nil {
		return fmt.Errorf("failed to list environments: %w", err)
	}

	envMap := make(map[string]string)
	for _, env := range envs {
		envMap[env.ID] = env.Name
	}

	// If env + server specified, get services for that server
	if servicesEnv != "" && servicesServer != "" {
		server, err := client.GetServerByEnvAndName(servicesEnv, servicesServer)
		if err != nil {
			return err
		}

		services, err := client.ListServices(server.ID)
		if err != nil {
			return fmt.Errorf("failed to list services: %w", err)
		}

		if len(services) == 0 {
			fmt.Printf("No services found on %s/%s\n", servicesEnv, servicesServer)
			return nil
		}

		table := output.NewTable([]string{"SERVICE", "STATUS", "HEALTH", "IMAGE", "TAG"})
		for _, svc := range services {
			table.Append([]string{
				svc.Name,
				output.StatusColor(svc.Status),
				output.HealthColor(svc.Health),
				svc.ImageName,
				svc.ImageTag,
			})
		}
		table.Render()
		return nil
	}

	// Get all servers, optionally filtered by env
	var filterEnvID string
	if servicesEnv != "" {
		for _, env := range envs {
			if env.Name == servicesEnv {
				filterEnvID = env.ID
				break
			}
		}
		if filterEnvID == "" {
			return fmt.Errorf("environment '%s' not found", servicesEnv)
		}
	}

	servers, err := client.ListServers(filterEnvID)
	if err != nil {
		return fmt.Errorf("failed to list servers: %w", err)
	}

	serverMap := make(map[string]string)
	for _, srv := range servers {
		serverMap[srv.ID] = srv.Name
	}

	// Get all services
	var allServices []struct {
		env, server string
		name        string
		status      string
		health      string
		image       string
		tag         string
	}

	for _, srv := range servers {
		services, err := client.ListServices(srv.ID)
		if err != nil {
			continue
		}
		for _, svc := range services {
			allServices = append(allServices, struct {
				env, server string
				name        string
				status      string
				health      string
				image       string
				tag         string
			}{
				env:    envMap[srv.EnvironmentID],
				server: srv.Name,
				name:   svc.Name,
				status: svc.Status,
				health: svc.Health,
				image:  svc.ImageName,
				tag:    svc.ImageTag,
			})
		}
	}

	if len(allServices) == 0 {
		fmt.Println("No services found")
		return nil
	}

	table := output.NewTable([]string{"ENV", "SERVER", "SERVICE", "STATUS", "HEALTH", "IMAGE", "TAG"})
	for _, svc := range allServices {
		table.Append([]string{
			svc.env,
			svc.server,
			svc.name,
			output.StatusColor(svc.status),
			output.HealthColor(svc.health),
			svc.image,
			svc.tag,
		})
	}
	table.Render()
	return nil
}
