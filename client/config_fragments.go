package client

import "fmt"

// ConfigFragment is reusable, environment-scoped config text included by config
// files (natural key: environment + name).
type ConfigFragment struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Description   *string `json:"description"`
	Content       string  `json:"content"`
	EnvironmentID string  `json:"environmentId,omitempty"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
}

// CreateConfigFragmentRequest is the body for POST /api/environments/:envId/config-fragments.
type CreateConfigFragmentRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	Content     string  `json:"content"`
}

// UpdateConfigFragmentRequest is the body for PATCH /api/config-fragments/:id.
type UpdateConfigFragmentRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Content     *string `json:"content,omitempty"`
}

// ListConfigFragments returns all config fragments for an environment.
func (c *Client) ListConfigFragments(environmentID string) ([]ConfigFragment, error) {
	var resp struct {
		Fragments []ConfigFragment `json:"fragments"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/config-fragments", environmentID), &resp); err != nil {
		return nil, err
	}
	return resp.Fragments, nil
}

// GetConfigFragment returns a single config fragment by ID.
func (c *Client) GetConfigFragment(id string) (*ConfigFragment, error) {
	var resp struct {
		Fragment ConfigFragment `json:"fragment"`
	}
	if err := c.Get(fmt.Sprintf("/api/config-fragments/%s", id), &resp); err != nil {
		return nil, err
	}
	return &resp.Fragment, nil
}

// CreateConfigFragment creates a config fragment in an environment.
func (c *Client) CreateConfigFragment(environmentID string, req CreateConfigFragmentRequest) (*ConfigFragment, error) {
	var resp struct {
		Fragment ConfigFragment `json:"fragment"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/config-fragments", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Fragment, nil
}

// UpdateConfigFragment updates a config fragment by ID.
func (c *Client) UpdateConfigFragment(id string, req UpdateConfigFragmentRequest) (*ConfigFragment, error) {
	var resp struct {
		Fragment ConfigFragment `json:"fragment"`
	}
	if err := c.Patch(fmt.Sprintf("/api/config-fragments/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Fragment, nil
}

// DeleteConfigFragment deletes a config fragment by ID. The API returns 409 if
// the fragment is still included by any config file.
func (c *Client) DeleteConfigFragment(id string) error {
	return c.Delete(fmt.Sprintf("/api/config-fragments/%s", id), nil)
}
