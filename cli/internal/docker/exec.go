package docker

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/bridgeinpt/bridgeport-cli/internal/ssh"
)

// ExecOptions configures docker exec behavior
type ExecOptions struct {
	Container   string
	Command     []string
	Interactive bool
	TTY         bool
	Shell       string // Override shell (default: /bin/sh)
}

// Exec runs docker exec on a remote server via SSH
func Exec(privateKey, username, host string, opts ExecOptions) error {
	return ssh.WithTemporaryKey(privateKey, func(keyPath string) error {
		// Build docker exec command
		dockerCmd := "docker exec"
		if opts.Interactive {
			dockerCmd += " -i"
		}
		if opts.TTY {
			dockerCmd += " -t"
		}
		dockerCmd += " " + opts.Container

		// Determine command to run
		if len(opts.Command) > 0 {
			// Custom command provided
			for _, arg := range opts.Command {
				dockerCmd += " " + shellQuote(arg)
			}
		} else {
			// Default to shell
			shell := opts.Shell
			if shell == "" {
				shell = "/bin/sh"
			}
			dockerCmd += " " + shell
		}

		// Build SSH args
		args := []string{
			"-i", keyPath,
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
		}

		if opts.TTY {
			args = append(args, "-t")
		}

		args = append(args, fmt.Sprintf("%s@%s", username, host), dockerCmd)

		sshPath, err := exec.LookPath("ssh")
		if err != nil {
			return fmt.Errorf("ssh command not found: %w", err)
		}

		return syscall.Exec(sshPath, append([]string{"ssh"}, args...), os.Environ())
	})
}

// Logs streams container logs from a remote server
func Logs(privateKey, username, host, container string, follow bool, tail int) error {
	return ssh.WithTemporaryKey(privateKey, func(keyPath string) error {
		// Build docker logs command
		dockerCmd := fmt.Sprintf("docker logs %s", container)
		if follow {
			dockerCmd += " -f"
		}
		if tail > 0 {
			dockerCmd += fmt.Sprintf(" --tail %d", tail)
		}

		args := []string{
			"-i", keyPath,
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			fmt.Sprintf("%s@%s", username, host),
			dockerCmd,
		}

		sshPath, err := exec.LookPath("ssh")
		if err != nil {
			return fmt.Errorf("ssh command not found: %w", err)
		}

		return syscall.Exec(sshPath, append([]string{"ssh"}, args...), os.Environ())
	})
}

// shellQuote quotes a string for safe use in shell commands
func shellQuote(s string) string {
	// Simple quoting - wrap in single quotes and escape any single quotes
	result := "'"
	for _, c := range s {
		if c == '\'' {
			result += `'\''`
		} else {
			result += string(c)
		}
	}
	result += "'"
	return result
}
