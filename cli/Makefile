# BRIDGEPORT CLI Makefile

BINARY_NAME=bridgeport
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME=$(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS=-ldflags "-X github.com/bridgein/bridgeport-cli/cmd.Version=${VERSION}"

.PHONY: build build-all install clean test lint

# Build for current OS/arch
build:
	go build ${LDFLAGS} -o ${BINARY_NAME} .

# Build for all platforms
build-all: clean
	mkdir -p dist
	GOOS=darwin GOARCH=amd64 go build ${LDFLAGS} -o dist/${BINARY_NAME}-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 go build ${LDFLAGS} -o dist/${BINARY_NAME}-darwin-arm64 .
	GOOS=linux GOARCH=amd64 go build ${LDFLAGS} -o dist/${BINARY_NAME}-linux-amd64 .
	GOOS=linux GOARCH=arm64 go build ${LDFLAGS} -o dist/${BINARY_NAME}-linux-arm64 .

# Install to GOPATH/bin
install:
	go install ${LDFLAGS} .

# Clean build artifacts
clean:
	rm -f ${BINARY_NAME}
	rm -rf dist/

# Run tests
test:
	go test -v ./...

# Run linter
lint:
	golangci-lint run

# Download dependencies
deps:
	go mod download

# Tidy dependencies
tidy:
	go mod tidy

# Generate completions
completions:
	mkdir -p completions
	./bridgeport completion bash > completions/bridgeport.bash
	./bridgeport completion zsh > completions/_bridgeport
	./bridgeport completion fish > completions/bridgeport.fish
