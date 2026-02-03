package cmd

import (
	"os"

	"github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
	Use:   "completion [bash|zsh|fish|powershell]",
	Short: "Generate shell completion scripts",
	Long: `Generate shell completion scripts for bridgeport.

To load completions:

Bash:
  # Linux
  $ bridgeport completion bash > /etc/bash_completion.d/bridgeport
  # macOS
  $ bridgeport completion bash > $(brew --prefix)/etc/bash_completion.d/bridgeport

Zsh:
  $ bridgeport completion zsh > "${fpath[1]}/_bridgeport"
  # You may need to restart your shell or run: compinit

Fish:
  $ bridgeport completion fish > ~/.config/fish/completions/bridgeport.fish

PowerShell:
  PS> bridgeport completion powershell | Out-String | Invoke-Expression
`,
	DisableFlagsInUseLine: true,
	ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
	Args:                  cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
	Run: func(cmd *cobra.Command, args []string) {
		switch args[0] {
		case "bash":
			rootCmd.GenBashCompletion(os.Stdout)
		case "zsh":
			rootCmd.GenZshCompletion(os.Stdout)
		case "fish":
			rootCmd.GenFishCompletion(os.Stdout, true)
		case "powershell":
			rootCmd.GenPowerShellCompletionWithDesc(os.Stdout)
		}
	},
}

func init() {
	rootCmd.AddCommand(completionCmd)

	// Register dynamic completion functions
	registerCompletions()
}

func registerCompletions() {
	// Environment completion for ssh, status, logs, exec, run
	envCompletion := func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) != 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		// Try to get environments from API
		client := getClient()
		if client == nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		envs, err := client.ListEnvironments()
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		var names []string
		for _, env := range envs {
			names = append(names, env.Name)
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	}

	// Server completion (depends on environment selection)
	serverCompletion := func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) != 1 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		envName := args[0]

		client := getClient()
		if client == nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		// Find environment ID
		envs, err := client.ListEnvironments()
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		var envID string
		for _, env := range envs {
			if env.Name == envName {
				envID = env.ID
				break
			}
		}
		if envID == "" {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		servers, err := client.ListServers(envID)
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		var names []string
		for _, server := range servers {
			names = append(names, server.Name)
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	}

	// Service completion (depends on server selection)
	serviceCompletion := func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) != 2 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		envName := args[0]
		serverName := args[1]

		client := getClient()
		if client == nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		server, err := client.GetServerByEnvAndName(envName, serverName)
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		services, err := client.ListServices(server.ID)
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}

		var names []string
		for _, svc := range services {
			names = append(names, svc.Name)
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	}

	// Register completions for each command
	sshCmd.RegisterFlagCompletionFunc("env", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		return envCompletion(cmd, args, toComplete)
	})
	sshCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return envCompletion(cmd, args, toComplete)
		}
		if len(args) == 1 {
			return serverCompletion(cmd, args, toComplete)
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	}

	statusCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return envCompletion(cmd, args, toComplete)
		}
		if len(args) == 1 {
			return serverCompletion(cmd, args, toComplete)
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	}

	logsCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return envCompletion(cmd, args, toComplete)
		}
		if len(args) == 1 {
			return serverCompletion(cmd, args, toComplete)
		}
		if len(args) == 2 {
			return serviceCompletion(cmd, args, toComplete)
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	}

	execCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return envCompletion(cmd, args, toComplete)
		}
		if len(args) == 1 {
			return serverCompletion(cmd, args, toComplete)
		}
		if len(args) == 2 {
			return serviceCompletion(cmd, args, toComplete)
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	}

	runCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return envCompletion(cmd, args, toComplete)
		}
		if len(args) == 1 {
			return serverCompletion(cmd, args, toComplete)
		}
		if len(args) == 2 {
			return serviceCompletion(cmd, args, toComplete)
		}
		// TODO: Could add command name completion here
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
}
