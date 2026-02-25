package ssh

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWithTemporaryKey(t *testing.T) {
	t.Run("creates temp file with correct content", func(t *testing.T) {
		privateKey := "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-content\n-----END OPENSSH PRIVATE KEY-----"

		var capturedPath string
		err := WithTemporaryKey(privateKey, func(keyPath string) error {
			capturedPath = keyPath

			// File should exist while callback runs
			content, err := os.ReadFile(keyPath)
			require.NoError(t, err)
			assert.Equal(t, privateKey, string(content))

			return nil
		})

		require.NoError(t, err)

		// File should be deleted after callback
		_, err = os.Stat(capturedPath)
		assert.True(t, os.IsNotExist(err), "temp key file should be deleted after callback")
	})

	t.Run("sets 0600 permissions", func(t *testing.T) {
		err := WithTemporaryKey("test-key", func(keyPath string) error {
			info, err := os.Stat(keyPath)
			require.NoError(t, err)
			assert.Equal(t, os.FileMode(0600), info.Mode().Perm())
			return nil
		})

		require.NoError(t, err)
	})

	t.Run("propagates callback error", func(t *testing.T) {
		err := WithTemporaryKey("test-key", func(keyPath string) error {
			return assert.AnError
		})

		assert.ErrorIs(t, err, assert.AnError)
	})

	t.Run("cleans up file even on callback error", func(t *testing.T) {
		var capturedPath string
		_ = WithTemporaryKey("test-key", func(keyPath string) error {
			capturedPath = keyPath
			return assert.AnError
		})

		_, err := os.Stat(capturedPath)
		assert.True(t, os.IsNotExist(err), "temp key file should be deleted even on error")
	})

	t.Run("uses bp-ssh prefix", func(t *testing.T) {
		err := WithTemporaryKey("test-key", func(keyPath string) error {
			// Path should contain bp-ssh prefix
			assert.Contains(t, keyPath, "bp-ssh-")
			return nil
		})

		require.NoError(t, err)
	})

	t.Run("handles empty key", func(t *testing.T) {
		err := WithTemporaryKey("", func(keyPath string) error {
			content, err := os.ReadFile(keyPath)
			require.NoError(t, err)
			assert.Empty(t, content)
			return nil
		})

		require.NoError(t, err)
	})
}
