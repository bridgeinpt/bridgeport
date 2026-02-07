package api

import "fmt"

type Registry struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	RegistryURL string  `json:"registryUrl"`
	IsDefault   bool    `json:"isDefault"`
	ImageCount  int     `json:"imageCount"`
	CreatedAt   string  `json:"createdAt"`
}

type ContainerImage struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	ImageName   string  `json:"imageName"`
	CurrentTag  string  `json:"currentTag"`
	LatestTag   *string `json:"latestTag"`
	AutoUpdate  bool    `json:"autoUpdate"`
	CreatedAt   string  `json:"createdAt"`
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
		registries[i] = Registry{
			ID:          r.ID,
			Name:        r.Name,
			Type:        r.Type,
			RegistryURL: r.RegistryURL,
			IsDefault:   r.IsDefault,
			ImageCount:  r.Count.ContainerImages,
			CreatedAt:   r.CreatedAt,
		}
	}
	return registries, nil
}

type registryRaw struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	RegistryURL string `json:"registryUrl"`
	IsDefault   bool   `json:"isDefault"`
	CreatedAt   string `json:"createdAt"`
	Count       struct {
		ContainerImages int `json:"containerImages"`
	} `json:"_count"`
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
