package docker

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestShellQuote(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"simple string", "hello", "'hello'"},
		{"string with spaces", "hello world", "'hello world'"},
		{"string with single quote", "it's", "'it'\\''s'"},
		{"empty string", "", "''"},
		{"string with double quotes", `say "hi"`, `'say "hi"'`},
		{"string with special chars", "foo;bar|baz", "'foo;bar|baz'"},
		{"string with newline", "foo\nbar", "'foo\nbar'"},
		{"string with backtick", "cmd `id`", "'cmd `id`'"},
		{"string with dollar sign", "$HOME", "'$HOME'"},
		{"multiple single quotes", "a'b'c", "'a'\\''b'\\''c'"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := shellQuote(tt.input)
			assert.Equal(t, tt.want, result)
		})
	}
}

func TestExecOptionsStruct(t *testing.T) {
	opts := ExecOptions{
		Container:   "my-app",
		Command:     []string{"ls", "-la"},
		Interactive: true,
		TTY:         true,
		Shell:       "/bin/bash",
	}

	assert.Equal(t, "my-app", opts.Container)
	assert.Equal(t, []string{"ls", "-la"}, opts.Command)
	assert.True(t, opts.Interactive)
	assert.True(t, opts.TTY)
	assert.Equal(t, "/bin/bash", opts.Shell)
}

func TestExecOptionsDefaults(t *testing.T) {
	opts := ExecOptions{
		Container: "web",
	}

	assert.Equal(t, "web", opts.Container)
	assert.Nil(t, opts.Command)
	assert.False(t, opts.Interactive)
	assert.False(t, opts.TTY)
	assert.Empty(t, opts.Shell)
}
