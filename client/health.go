package client

// Health mirrors GET /health — the instance's status and version triple.
// /health is the canonical version source (there is deliberately no
// /api/version route); it is unauthenticated, so it is always reachable.
type Health struct {
	Status              string `json:"status"`
	Timestamp           string `json:"timestamp"`
	Version             string `json:"version"` // running BridgePort app version
	BundledAgentVersion string `json:"bundledAgentVersion"`
	CliVersion          string `json:"cliVersion"`
}

// GetHealth returns the instance status and version triple from GET /health.
func (c *Client) GetHealth() (*Health, error) {
	var h Health
	if err := c.Get("/health", &h); err != nil {
		return nil, err
	}
	return &h, nil
}
