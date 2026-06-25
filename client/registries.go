package client

import "fmt"

// Registry is a registry connection. Credentials (token/password) are
// write-only and never returned — reads expose only HasToken/HasPassword.
// Type is one of: "digitalocean", "dockerhub", "generic".
type Registry struct {
	ID                     string  `json:"id"`
	Name                   string  `json:"name"`
	Type                   string  `json:"type"`
	RegistryURL            string  `json:"registryUrl"`
	RepositoryPrefix       *string `json:"repositoryPrefix,omitempty"`
	Username               *string `json:"username,omitempty"`
	HasToken               bool    `json:"hasToken,omitempty"`
	HasPassword            bool    `json:"hasPassword,omitempty"`
	IsDefault              bool    `json:"isDefault"`
	RefreshIntervalMinutes int     `json:"refreshIntervalMinutes,omitempty"`
	AutoLinkPattern        *string `json:"autoLinkPattern,omitempty"`
	LastRefreshAt          *string `json:"lastRefreshAt,omitempty"`
	EnvironmentID          string  `json:"environmentId,omitempty"`
	ImageCount             int     `json:"imageCount"` // populated from _count on list/detail
	CreatedAt              string  `json:"createdAt"`
	UpdatedAt              string  `json:"updatedAt,omitempty"`
}

type ContainerImage struct {
	ID                   string  `json:"id"`
	Name                 string  `json:"name"`
	ImageName            string  `json:"imageName"`
	TagFilter            string  `json:"tagFilter,omitempty"`
	CurrentTag           string  `json:"currentTag,omitempty"`
	LatestTag            *string `json:"latestTag,omitempty"`
	AutoUpdate           bool    `json:"autoUpdate"`
	UpdateAvailable      bool    `json:"updateAvailable,omitempty"`
	RegistryConnectionID *string `json:"registryConnectionId,omitempty"`
	EnvironmentID        string  `json:"environmentId,omitempty"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            string  `json:"updatedAt,omitempty"`
}

// ListRegistries returns all registries for an environment
func (c *Client) ListRegistries(environmentID string) ([]Registry, error) {
	var response struct {
		Registries []registryRaw `json:"registries"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/registries", environmentID), &response); err != nil {
		return nil, err
	}

	registries := make([]Registry, len(response.Registries))
	for i, r := range response.Registries {
		registries[i] = r.toRegistry()
	}
	return registries, nil
}

// GetRegistry returns a single registry connection by ID.
func (c *Client) GetRegistry(id string) (*Registry, error) {
	var resp struct {
		Registry registryRaw `json:"registry"`
	}
	if err := c.Get(fmt.Sprintf("/api/registries/%s", id), &resp); err != nil {
		return nil, err
	}
	reg := resp.Registry.toRegistry()
	return &reg, nil
}

// GetRegistryByName finds a registry connection by name within an environment
// (registries are unique per environment + name).
func (c *Client) GetRegistryByName(environmentID, name string) (*Registry, error) {
	registries, err := c.ListRegistries(environmentID)
	if err != nil {
		return nil, err
	}
	for i := range registries {
		if registries[i].Name == name {
			return &registries[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("registry '%s' not found in environment '%s'", name, environmentID)}
}

// registryRaw is the wire shape for a registry: the full Registry plus the
// image count, which the API exposes as _count.containerImages rather than a
// direct imageCount field. Embedding Registry captures every registry field;
// toRegistry folds the count into Registry.ImageCount.
type registryRaw struct {
	Registry
	Count struct {
		ContainerImages int `json:"containerImages"`
	} `json:"_count"`
}

func (r registryRaw) toRegistry() Registry {
	reg := r.Registry
	reg.ImageCount = r.Count.ContainerImages
	return reg
}

// ListContainerImages returns all container images for an environment
func (c *Client) ListContainerImages(environmentID string) ([]ContainerImage, error) {
	var response struct {
		Images []ContainerImage `json:"images"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/container-images", environmentID), &response); err != nil {
		return nil, err
	}
	return response.Images, nil
}

// CreateRegistryRequest is the body for POST /api/environments/:envId/registries.
// Token and Password are write-only credentials. Type: "digitalocean" | "dockerhub" | "generic".
type CreateRegistryRequest struct {
	Name                   string  `json:"name"`
	Type                   string  `json:"type"`
	RegistryURL            string  `json:"registryUrl"`
	RepositoryPrefix       *string `json:"repositoryPrefix,omitempty"`
	Token                  *string `json:"token,omitempty"`
	Username               *string `json:"username,omitempty"`
	Password               *string `json:"password,omitempty"`
	IsDefault              *bool   `json:"isDefault,omitempty"`
	RefreshIntervalMinutes *int    `json:"refreshIntervalMinutes,omitempty"`
	AutoLinkPattern        *string `json:"autoLinkPattern,omitempty"`
}

// UpdateRegistryRequest is the body for PATCH /api/registries/:id. Sending a
// credential clears it when set to "" (the API treats empty as clear).
type UpdateRegistryRequest struct {
	Name                   *string `json:"name,omitempty"`
	Type                   *string `json:"type,omitempty"`
	RegistryURL            *string `json:"registryUrl,omitempty"`
	RepositoryPrefix       *string `json:"repositoryPrefix,omitempty"`
	Token                  *string `json:"token,omitempty"`
	Username               *string `json:"username,omitempty"`
	Password               *string `json:"password,omitempty"`
	IsDefault              *bool   `json:"isDefault,omitempty"`
	RefreshIntervalMinutes *int    `json:"refreshIntervalMinutes,omitempty"`
	AutoLinkPattern        *string `json:"autoLinkPattern,omitempty"`
}

// CreateRegistry creates a registry connection (natural key: environment + name).
func (c *Client) CreateRegistry(environmentID string, req CreateRegistryRequest) (*Registry, error) {
	var resp struct {
		Registry Registry `json:"registry"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/registries", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Registry, nil
}

// UpdateRegistry updates a registry connection by ID.
func (c *Client) UpdateRegistry(id string, req UpdateRegistryRequest) (*Registry, error) {
	var resp struct {
		Registry Registry `json:"registry"`
	}
	if err := c.Patch(fmt.Sprintf("/api/registries/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Registry, nil
}

// DeleteRegistry deletes a registry connection by ID. The API returns 400 if
// container images are still attached.
func (c *Client) DeleteRegistry(id string) error {
	return c.Delete(fmt.Sprintf("/api/registries/%s", id), nil)
}
