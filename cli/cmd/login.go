package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/bridgein/bridgeport-cli/internal/api"
	"github.com/bridgein/bridgeport-cli/internal/config"
	"github.com/bridgein/bridgeport-cli/internal/output"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with BridgePort",
	Long: `Authenticate with your BridgePort server.

You can provide credentials interactively or via flags:
  bridgeport login
  bridgeport login --email user@example.com

The token will be saved to ~/.bridgeport/config.yaml for future use.`,
	RunE: runLogin,
}

var (
	loginEmail    string
	loginPassword string
	loginSave     bool
)

func init() {
	rootCmd.AddCommand(loginCmd)
	loginCmd.Flags().StringVar(&loginEmail, "email", "", "Email address")
	loginCmd.Flags().StringVar(&loginPassword, "password", "", "Password (not recommended, use interactive prompt)")
	loginCmd.Flags().BoolVar(&loginSave, "save", true, "Save token to config file")
}

func runLogin(cmd *cobra.Command, args []string) error {
	reader := bufio.NewReader(os.Stdin)

	// Get email if not provided
	email := loginEmail
	if email == "" {
		fmt.Print("Email: ")
		input, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("failed to read email: %w", err)
		}
		email = strings.TrimSpace(input)
	}

	// Get password if not provided
	password := loginPassword
	if password == "" {
		fmt.Print("Password: ")
		passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
		if err != nil {
			return fmt.Errorf("failed to read password: %w", err)
		}
		password = string(passwordBytes)
		fmt.Println() // New line after password input
	}

	// Get server URL from config
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	url := cfg.URL
	if serverURL != "" {
		url = serverURL
	}

	// Create a temporary client for login
	client := api.NewClient(url, "")

	fmt.Printf("Logging in to %s...\n", url)

	resp, err := client.Login(email, password)
	if err != nil {
		return fmt.Errorf("login failed: %w", err)
	}

	fmt.Printf("%s Logged in as %s (%s)\n", output.Green("✓"), resp.User.Email, resp.User.Role)

	// Ask to save if not specified
	if loginSave {
		cfg.Token = resp.Token
		cfg.URL = url
		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("failed to save token: %w", err)
		}
		configPath, _ := config.GetConfigPath()
		fmt.Printf("Token saved to %s\n", configPath)
	}

	return nil
}
