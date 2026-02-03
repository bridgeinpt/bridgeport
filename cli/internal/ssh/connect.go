package ssh

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// WithTemporaryKey creates a temporary file with the SSH key, runs the function, then deletes it
func WithTemporaryKey(privateKey string, fn func(keyPath string) error) error {
	// Create temp file with restricted permissions
	f, err := os.CreateTemp("", "bp-ssh-*")
	if err != nil {
		return fmt.Errorf("failed to create temp key file: %w", err)
	}
	defer os.Remove(f.Name())

	// Set permissions before writing (600 = owner read/write only)
	if err := os.Chmod(f.Name(), 0600); err != nil {
		return fmt.Errorf("failed to set key file permissions: %w", err)
	}

	// Write key content
	if _, err := f.WriteString(privateKey); err != nil {
		return fmt.Errorf("failed to write key file: %w", err)
	}

	if err := f.Close(); err != nil {
		return fmt.Errorf("failed to close key file: %w", err)
	}

	return fn(f.Name())
}

// Connect opens an interactive SSH session to a server
func Connect(privateKey, username, host string, command []string) error {
	return WithTemporaryKey(privateKey, func(keyPath string) error {
		args := []string{
			"-i", keyPath,
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			fmt.Sprintf("%s@%s", username, host),
		}

		// Append command if provided
		if len(command) > 0 {
			args = append(args, command...)
		}

		sshPath, err := exec.LookPath("ssh")
		if err != nil {
			return fmt.Errorf("ssh command not found: %w", err)
		}

		// Use syscall.Exec to replace the current process
		// This gives the user a proper interactive session
		return syscall.Exec(sshPath, append([]string{"ssh"}, args...), os.Environ())
	})
}

// RunCommand runs a command via SSH and returns the output (non-interactive)
func RunCommand(privateKey, username, host string, command []string) (string, error) {
	var output string
	err := WithTemporaryKey(privateKey, func(keyPath string) error {
		args := []string{
			"-i", keyPath,
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			"-o", "BatchMode=yes",
			fmt.Sprintf("%s@%s", username, host),
		}
		args = append(args, command...)

		cmd := exec.Command("ssh", args...)
		out, err := cmd.CombinedOutput()
		output = string(out)
		return err
	})
	return output, err
}
