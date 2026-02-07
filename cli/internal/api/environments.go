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
	// If environment ID provided, get servers for that environment
	if environmentID != "" {
		return c.listServersForEnv(environmentID)
	}

	// Otherwise, get servers from all environments
	envs, err := c.ListEnvironments()
	if err != nil {
		return nil, err
	}

	var allServers []Server
	for _, env := range envs {
		servers, err := c.listServersForEnv(env.ID)
		if err != nil {
			// Continue with other environments on error
			continue
		}
		allServers = append(allServers, servers...)
	}
	return allServers, nil
}

// listServersForEnv returns servers for a specific environment
func (c *Client) listServersForEnv(environmentID string) ([]Server, error) {
	var response struct {
		Servers []Server `json:"servers"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/servers", environmentID), &response); err != nil {
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

// GetEnvironmentByName finds an environment by name and returns it
func (c *Client) GetEnvironmentByName(name string) (*Environment, error) {
	envs, err := c.ListEnvironments()
	if err != nil {
		return nil, err
	}

	for _, env := range envs {
		if env.Name == name {
			return &env, nil
		}
	}

	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("environment '%s' not found", name)}
}

// GetDatabaseByName finds a database by name within an environment
func (c *Client) GetDatabaseByName(environmentID, name string) (*Database, error) {
	databases, err := c.ListDatabases(environmentID)
	if err != nil {
		return nil, err
	}

	for _, db := range databases {
		if db.Name == name {
			return &db, nil
		}
	}

	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("database '%s' not found", name)}
}
