.PHONY: build build-linux clean

# Binary name
BINARY=bridgeport-agent

# Build for current platform
build:
	go build -o $(BINARY) .

# Build for Linux (for deployment to servers)
build-linux:
	GOOS=linux GOARCH=amd64 go build -o $(BINARY)-linux-amd64 .
	GOOS=linux GOARCH=arm64 go build -o $(BINARY)-linux-arm64 .

# Clean build artifacts
clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64 $(BINARY)-linux-arm64

# Install systemd service
install:
	@echo "Copy the agent binary to the target server, then:"
	@echo "1. Copy bridgeport-agent.service to /etc/systemd/system/"
	@echo "2. Edit the service file with your server URL and token"
	@echo "3. sudo systemctl daemon-reload"
	@echo "4. sudo systemctl enable --now bridgeport-agent"
