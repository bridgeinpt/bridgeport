package client

import "fmt"

// CreateServerRequest is the body for POST /api/environments/:envId/servers.
type CreateServerRequest struct {
	Name     string   `json:"name"`
	Hostname string   `json:"hostname"`
	PublicIP *string  `json:"publicIp,omitempty"`
	Tags     []string `json:"tags,omitempty"`
}

// UpdateServerRequest is the body for PATCH /api/servers/:id. All fields are
// optional; omitted fields are left unchanged. DockerMode is "ssh" or "socket".
// To clear publicIp send an empty string; clusterId clears with an empty string
// rejected by the API, so omit it to leave unchanged.
type UpdateServerRequest struct {
	Name       *string  `json:"name,omitempty"`
	Hostname   *string  `json:"hostname,omitempty"`
	PublicIP   *string  `json:"publicIp,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	DockerMode *string  `json:"dockerMode,omitempty"`
	ClusterID  *string  `json:"clusterId,omitempty"`
}

// CreateServer creates a server in an environment (natural key: environment + name).
func (c *Client) CreateServer(environmentID string, req CreateServerRequest) (*Server, error) {
	var resp struct {
		Server Server `json:"server"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/servers", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Server, nil
}

// UpdateServer updates a server by ID.
func (c *Client) UpdateServer(id string, req UpdateServerRequest) (*Server, error) {
	var resp struct {
		Server Server `json:"server"`
	}
	if err := c.Patch(fmt.Sprintf("/api/servers/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Server, nil
}

// DeleteServer deletes a server by ID (admin only).
func (c *Client) DeleteServer(id string) error {
	return c.Delete(fmt.Sprintf("/api/servers/%s", id), nil)
}
