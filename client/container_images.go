package client

import "fmt"

// CreateContainerImageRequest is the body for POST /api/environments/:envId/container-images.
// TagFilter defaults to "latest" server-side when omitted.
type CreateContainerImageRequest struct {
	Name                 string  `json:"name"`
	ImageName            string  `json:"imageName"`
	TagFilter            *string `json:"tagFilter,omitempty"`
	RegistryConnectionID *string `json:"registryConnectionId,omitempty"`
}

// UpdateContainerImageRequest is the body for PATCH /api/container-images/:id.
type UpdateContainerImageRequest struct {
	Name                 *string `json:"name,omitempty"`
	TagFilter            *string `json:"tagFilter,omitempty"`
	RegistryConnectionID *string `json:"registryConnectionId,omitempty"`
	AutoUpdate           *bool   `json:"autoUpdate,omitempty"`
}

// GetContainerImage returns a single container image by ID.
func (c *Client) GetContainerImage(id string) (*ContainerImage, error) {
	var resp struct {
		Image ContainerImage `json:"image"`
	}
	if err := c.Get(fmt.Sprintf("/api/container-images/%s", id), &resp); err != nil {
		return nil, err
	}
	return &resp.Image, nil
}

// CreateContainerImage creates a container image (natural key: environment + imageName).
func (c *Client) CreateContainerImage(environmentID string, req CreateContainerImageRequest) (*ContainerImage, error) {
	var resp struct {
		Image ContainerImage `json:"image"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/container-images", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Image, nil
}

// UpdateContainerImage updates a container image by ID.
func (c *Client) UpdateContainerImage(id string, req UpdateContainerImageRequest) (*ContainerImage, error) {
	var resp struct {
		Image ContainerImage `json:"image"`
	}
	if err := c.Patch(fmt.Sprintf("/api/container-images/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Image, nil
}

// DeleteContainerImage deletes a container image by ID. The API returns 400 if
// any service is still linked to it.
func (c *Client) DeleteContainerImage(id string) error {
	return c.Delete(fmt.Sprintf("/api/container-images/%s", id), nil)
}
