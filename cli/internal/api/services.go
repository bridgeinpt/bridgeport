package api

import "fmt"

type Service struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	ImageName     string   `json:"imageName"`
	ImageTag      string   `json:"imageTag"`
	Status        string   `json:"status"`
	Health        string   `json:"health"`
	ServerID      string   `json:"serverId"`
	Server        *Server  `json:"server,omitempty"`
	ServiceTypeID *string  `json:"serviceTypeId"`
	ServiceType   *ServiceType `json:"serviceType,omitempty"`
	CreatedAt     string   `json:"createdAt"`
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
