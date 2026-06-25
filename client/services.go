package client

import "fmt"

// ServiceDeployment is one per-server runtime row attached to a Service template.
// Config fields (containerName, composePath, envOverrides) are settable; the
// rest (status/health/discovery/exposedPorts) are runtime-computed and read-only.
type ServiceDeployment struct {
	ID            string  `json:"id"`
	ServiceID     string  `json:"serviceId"`
	ServerID      string  `json:"serverId"`
	ContainerName string  `json:"containerName"`
	ComposePath   *string `json:"composePath,omitempty"`
	EnvOverrides  string  `json:"envOverrides,omitempty"` // raw JSON-encoded map string
	// Runtime / computed (read-only):
	Status          string  `json:"status"`
	ContainerStatus string  `json:"containerStatus"`
	HealthStatus    string  `json:"healthStatus"`
	DiscoveryStatus string  `json:"discoveryStatus"`
	ExposedPorts    *string `json:"exposedPorts,omitempty"` // raw JSON-encoded array string
	LastDeployedAt  *string `json:"lastDeployedAt,omitempty"`
	Server          *Server `json:"server,omitempty"`
}

// Service is the template. After the 2.0 split it is environment-scoped and
// references zero-or-more ServiceDeployments. The backend additionally flattens
// the first deployment's runtime onto the service row for back-compat (these
// are the lower-case omitempty fields below).
type Service struct {
	ID                 string              `json:"id"`
	Name               string              `json:"name"`
	ImageTag           string              `json:"imageTag"`
	ComposeTemplate    *string             `json:"composeTemplate,omitempty"`
	HealthCheckURL     *string             `json:"healthCheckUrl,omitempty"`
	BaseEnv            string              `json:"baseEnv,omitempty"` // raw JSON-encoded map string
	DeployStrategy     string              `json:"deployStrategy,omitempty"`
	HealthWaitMs       int                 `json:"healthWaitMs,omitempty"`
	HealthRetries      int                 `json:"healthRetries,omitempty"`
	HealthIntervalMs   int                 `json:"healthIntervalMs,omitempty"`
	EnvironmentID      string              `json:"environmentId"`
	ContainerImageID   string              `json:"containerImageId"`
	ContainerImage     *ContainerImage     `json:"containerImage,omitempty"`
	ServiceTypeID      *string             `json:"serviceTypeId"`
	ServiceType        *ServiceType        `json:"serviceType,omitempty"`
	ServiceDeployments []ServiceDeployment `json:"serviceDeployments,omitempty"`
	CreatedAt          string              `json:"createdAt"`

	// --- Back-compat fields surfaced by the backend (flattened from the first
	// ServiceDeployment so legacy CLI flows keep working). ---
	ContainerName   string  `json:"containerName,omitempty"`
	Status          string  `json:"status,omitempty"`
	ContainerStatus string  `json:"containerStatus,omitempty"`
	HealthStatus    string  `json:"healthStatus,omitempty"`
	ServerID        string  `json:"serverId,omitempty"`
	Server          *Server `json:"server,omitempty"`
}

// ImageName returns the image name from the linked container image, or empty
// when no container image is loaded.
func (s *Service) ImageName() string {
	if s.ContainerImage != nil {
		return s.ContainerImage.ImageName
	}
	return ""
}

// Health returns the service's health status across all deployments.
// Returns "unknown" if no deployments exist or no health data is available.
func (s *Service) Health() string {
	if s.HealthStatus != "" {
		return s.HealthStatus
	}
	for _, d := range s.ServiceDeployments {
		if d.HealthStatus != "" {
			return d.HealthStatus
		}
	}
	return "unknown"
}

type ServiceType struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	DisplayName string               `json:"displayName"`
	Commands    []ServiceTypeCommand `json:"commands"`
}

type ServiceTypeCommand struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Command     string `json:"command"`
	Description string `json:"description"`
}

type RunCommandRequest struct {
	CommandName string `json:"commandName"`
}

type RunCommandResponse struct {
	Command string `json:"command"`
}

// ListServices returns all services, optionally filtered by server ID
func (c *Client) ListServices(serverID string) ([]Service, error) {
	// If server ID provided, get services for that server
	if serverID != "" {
		return c.listServicesForServer(serverID)
	}

	// Otherwise, get services from all servers across all environments
	// First get all environments
	var envResponse struct {
		Environments []struct {
			ID string `json:"id"`
		} `json:"environments"`
	}
	if err := c.Get("/api/environments", &envResponse); err != nil {
		return nil, err
	}

	var allServices []Service
	for _, env := range envResponse.Environments {
		// Get servers for this environment
		var srvResponse struct {
			Servers []struct {
				ID string `json:"id"`
			} `json:"servers"`
		}
		if err := c.Get(fmt.Sprintf("/api/environments/%s/servers", env.ID), &srvResponse); err != nil {
			continue
		}

		// Get services for each server
		for _, srv := range srvResponse.Servers {
			services, err := c.listServicesForServer(srv.ID)
			if err != nil {
				continue
			}
			allServices = append(allServices, services...)
		}
	}
	return allServices, nil
}

// listServicesForServer returns services for a specific server
func (c *Client) listServicesForServer(serverID string) ([]Service, error) {
	var response struct {
		Services []Service `json:"services"`
	}
	if err := c.Get(fmt.Sprintf("/api/servers/%s/services", serverID), &response); err != nil {
		return nil, err
	}
	return response.Services, nil
}

// GetService returns a single service by ID
func (c *Client) GetService(id string) (*Service, error) {
	var service Service
	if err := c.Get(fmt.Sprintf("/api/services/%s", id), &service); err != nil {
		return nil, err
	}
	return &service, nil
}

// GetServiceByName finds a service by name on a specific server
func (c *Client) GetServiceByName(serverID, serviceName string) (*Service, error) {
	services, err := c.ListServices(serverID)
	if err != nil {
		return nil, err
	}

	for _, svc := range services {
		if svc.Name == serviceName {
			return &svc, nil
		}
	}

	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("service '%s' not found", serviceName)}
}

// GetRunCommand gets the actual command for a predefined command
func (c *Client) GetRunCommand(serviceID, commandName string) (string, error) {
	req := RunCommandRequest{CommandName: commandName}
	var resp RunCommandResponse
	if err := c.Post(fmt.Sprintf("/api/services/%s/run-command", serviceID), req, &resp); err != nil {
		return "", err
	}
	return resp.Command, nil
}

// ListServiceTypes returns all service types with their commands
func (c *Client) ListServiceTypes() ([]ServiceType, error) {
	var response struct {
		ServiceTypes []ServiceType `json:"serviceTypes"`
	}
	if err := c.Get("/api/settings/service-types", &response); err != nil {
		return nil, err
	}
	return response.ServiceTypes, nil
}

// --- Service template CRUD ---

// CreateServiceRequest is the body for POST /api/environments/:envId/services.
// ImageTag defaults to "latest" server-side. DeployStrategy: "sequential" | "parallel".
type CreateServiceRequest struct {
	Name             string            `json:"name"`
	ContainerImageID string            `json:"containerImageId"`
	ImageTag         *string           `json:"imageTag,omitempty"`
	ComposeTemplate  *string           `json:"composeTemplate,omitempty"`
	HealthCheckURL   *string           `json:"healthCheckUrl,omitempty"`
	BaseEnv          map[string]string `json:"baseEnv,omitempty"`
	DeployStrategy   *string           `json:"deployStrategy,omitempty"`
}

// UpdateServiceRequest is the body for PATCH /api/services/:id.
type UpdateServiceRequest struct {
	Name             *string           `json:"name,omitempty"`
	ContainerImageID *string           `json:"containerImageId,omitempty"`
	ImageTag         *string           `json:"imageTag,omitempty"`
	ComposeTemplate  *string           `json:"composeTemplate,omitempty"`
	HealthCheckURL   *string           `json:"healthCheckUrl,omitempty"`
	BaseEnv          map[string]string `json:"baseEnv,omitempty"`
	DeployStrategy   *string           `json:"deployStrategy,omitempty"`
	ServiceTypeID    *string           `json:"serviceTypeId,omitempty"`
	HealthWaitMs     *int              `json:"healthWaitMs,omitempty"`
	HealthRetries    *int              `json:"healthRetries,omitempty"`
	HealthIntervalMs *int              `json:"healthIntervalMs,omitempty"`
}

// CreateService creates a service template (natural key: environment + name).
func (c *Client) CreateService(environmentID string, req CreateServiceRequest) (*Service, error) {
	var resp struct {
		Service Service `json:"service"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/services", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Service, nil
}

// UpdateService updates a service template by ID.
func (c *Client) UpdateService(id string, req UpdateServiceRequest) (*Service, error) {
	var resp struct {
		Service Service `json:"service"`
	}
	if err := c.Patch(fmt.Sprintf("/api/services/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Service, nil
}

// DeleteService deletes a service template by ID (cascades its deployments).
func (c *Client) DeleteService(id string) error {
	return c.Delete(fmt.Sprintf("/api/services/%s", id), nil)
}

// --- ServiceDeployment CRUD (per-server placement) ---

// CreateDeploymentRequest is the body for POST /api/services/:id/deployments.
type CreateDeploymentRequest struct {
	ServerID      string            `json:"serverId"`
	ContainerName string            `json:"containerName"`
	ComposePath   *string           `json:"composePath,omitempty"`
	EnvOverrides  map[string]string `json:"envOverrides,omitempty"`
}

// UpdateDeploymentRequest is the body for PATCH /api/services/:id/deployments/:depId.
// ServerID is not updatable — a deployment cannot be moved between servers.
type UpdateDeploymentRequest struct {
	ContainerName *string           `json:"containerName,omitempty"`
	ComposePath   *string           `json:"composePath,omitempty"`
	EnvOverrides  map[string]string `json:"envOverrides,omitempty"`
}

// CreateDeployment adds a deployment of a service template onto a server.
func (c *Client) CreateDeployment(serviceID string, req CreateDeploymentRequest) (*ServiceDeployment, error) {
	var resp struct {
		Deployment ServiceDeployment `json:"deployment"`
	}
	if err := c.Post(fmt.Sprintf("/api/services/%s/deployments", serviceID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Deployment, nil
}

// UpdateDeployment updates a deployment.
func (c *Client) UpdateDeployment(serviceID, deploymentID string, req UpdateDeploymentRequest) (*ServiceDeployment, error) {
	var resp struct {
		Deployment ServiceDeployment `json:"deployment"`
	}
	if err := c.Patch(fmt.Sprintf("/api/services/%s/deployments/%s", serviceID, deploymentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Deployment, nil
}

// DeleteDeployment removes a deployment (the template is retained).
func (c *Client) DeleteDeployment(serviceID, deploymentID string) error {
	return c.Delete(fmt.Sprintf("/api/services/%s/deployments/%s", serviceID, deploymentID), nil)
}

// --- Config-file attachments (ConfigFile <-> Service) ---

// ServiceFile is a config-file-to-service attachment.
type ServiceFile struct {
	ID                  string      `json:"id"`
	ServiceID           string      `json:"serviceId"`
	ConfigFileID        string      `json:"configFileId"`
	ServiceDeploymentID *string     `json:"serviceDeploymentId,omitempty"`
	TargetPath          string      `json:"targetPath"`
	ConfigFile          *ConfigFile `json:"configFile,omitempty"`
}

// AttachFileRequest is the body for POST /api/services/:id/files.
type AttachFileRequest struct {
	ConfigFileID string `json:"configFileId"`
	TargetPath   string `json:"targetPath"`
}

// AttachConfigFile attaches a config file to a service at a target path.
func (c *Client) AttachConfigFile(serviceID string, req AttachFileRequest) (*ServiceFile, error) {
	var resp struct {
		ServiceFile ServiceFile `json:"serviceFile"`
	}
	if err := c.Post(fmt.Sprintf("/api/services/%s/files", serviceID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.ServiceFile, nil
}

// UpdateServiceFile changes the target path of an attachment. The path segment
// is the configFileId of the base attachment.
func (c *Client) UpdateServiceFile(serviceID, configFileID, targetPath string) (*ServiceFile, error) {
	var resp struct {
		ServiceFile ServiceFile `json:"serviceFile"`
	}
	body := map[string]string{"targetPath": targetPath}
	if err := c.Patch(fmt.Sprintf("/api/services/%s/files/%s", serviceID, configFileID), body, &resp); err != nil {
		return nil, err
	}
	return &resp.ServiceFile, nil
}

// DetachConfigFile removes a config-file attachment from a service. The path
// segment is the configFileId.
func (c *Client) DetachConfigFile(serviceID, configFileID string) error {
	return c.Delete(fmt.Sprintf("/api/services/%s/files/%s", serviceID, configFileID), nil)
}
