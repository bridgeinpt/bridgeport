package api

import "fmt"

type Environment struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	DisplayName  string `json:"displayName"`
	SSHConfigured bool  `json:"sshConfigured"`
	CreatedAt    string `json:"createdAt"`
}

type Server struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	PrivateIP     string  `json:"privateIp"`
	PublicIP      *string `json:"publicIp"`
	EnvironmentID string  `json:"environmentId"`
	Environment   *Environment `json:"environment,omitempty"`
	Status        string  `json:"status"`
	Metrics       *ServerMetrics `json:"metrics,omitempty"`
	CreatedAt     string  `json:"createdAt"`
}

type ServerMetrics struct {
	CPUPercent    float64 `json:"cpuPercent"`
	MemoryPercent float64 `json:"memoryPercent"`
	MemoryUsedMB  int64   `json:"memoryUsedMb"`
	MemoryTotalMB int64   `json:"memoryTotalMb"`
	DiskPercent   float64 `json:"diskPercent"`
	DiskUsedGB    float64 `json:"diskUsedGb"`
	DiskTotalGB   float64 `json:"diskTotalGb"`
	UptimeSeconds int64   `json:"uptimeSeconds"`
	Timestamp     string  `json:"timestamp"`
}

type SSHCredentials struct {
	PrivateKey string `json:"privateKey"`
	Username   string `json:"username"`
}

// ListEnvironments returns all environments
func (c *Client) ListEnvironments() ([]Environment, error) {
	var response struct {
		Environments []Environment `json:"environments"`
	}
	if err := c.Get("/api/environments", &response); err != nil {
		return nil, err
	}
	return response.Environments, nil
}

// GetEnvironment returns a single environment by ID
func (c *Client) GetEnvironment(id string) (*Environment, error) {
	var env Environment
	if err := c.Get(fmt.Sprintf("/api/environments/%s", id), &env); err != nil {
		return nil, err
	}
	return &env, nil
}

// ListServers returns all servers, optionally filtered by environment
func (c *Client) ListServers(environmentID string) ([]Server, error) {
	path := "/api/servers"
	if environmentID != "" {
		path = fmt.Sprintf("/api/servers?environmentId=%s", environmentID)
	}
	var response struct {
		Servers []Server `json:"servers"`
	}
	if err := c.Get(path, &response); err != nil {
		return nil, err
	}
	return response.Servers, nil
}

// GetServer returns a single server by ID
func (c *Client) GetServer(id string) (*Server, error) {
	var server Server
	if err := c.Get(fmt.Sprintf("/api/servers/%s", id), &server); err != nil {
		return nil, err
	}
	return &server, nil
}

// GetServerByEnvAndName finds a server by environment name and server name
func (c *Client) GetServerByEnvAndName(envName, serverName string) (*Server, error) {
	// First get environment by name
	envs, err := c.ListEnvironments()
	if err != nil {
		return nil, err
	}

	var envID string
	for _, env := range envs {
		if env.Name == envName {
			envID = env.ID
			break
		}
	}
	if envID == "" {
		return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("environment '%s' not found", envName)}
	}

	// Get servers in environment
	servers, err := c.ListServers(envID)
	if err != nil {
		return nil, err
	}

	for _, server := range servers {
		if server.Name == serverName {
			return &server, nil
		}
	}

	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("server '%s' not found in environment '%s'", serverName, envName)}
}

// GetSSHKey returns the SSH credentials for an environment
func (c *Client) GetSSHKey(environmentID string) (*SSHCredentials, error) {
	var creds SSHCredentials
	if err := c.Get(fmt.Sprintf("/api/environments/%s/ssh-key", environmentID), &creds); err != nil {
		return nil, err
	}
	return &creds, nil
}

// GetServerMetrics returns detailed metrics for a server
func (c *Client) GetServerMetrics(serverID string) (*ServerMetrics, error) {
	var metrics ServerMetrics
	if err := c.Get(fmt.Sprintf("/api/servers/%s/metrics", serverID), &metrics); err != nil {
		return nil, err
	}
	return &metrics, nil
}
