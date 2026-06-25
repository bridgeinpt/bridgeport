package client

import "fmt"

// Var is a non-secret, environment-scoped key/value (natural key: environment + key).
// Unlike secrets, the value is stored in plaintext and returned by the API.
type Var struct {
	ID          string  `json:"id"`
	Key         string  `json:"key"`
	Value       string  `json:"value"`
	Description *string `json:"description"`
	UsageCount  int     `json:"usageCount,omitempty"` // present on list only
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// CreateVarRequest is the body for POST /api/environments/:envId/vars.
// Key must match /^[A-Z][A-Z0-9_]*$/.
type CreateVarRequest struct {
	Key         string  `json:"key"`
	Value       string  `json:"value"`
	Description *string `json:"description,omitempty"`
}

// UpdateVarRequest is the body for PATCH /api/vars/:id.
type UpdateVarRequest struct {
	Value       *string `json:"value,omitempty"`
	Description *string `json:"description,omitempty"`
}

// ListVars returns all vars for an environment (with values).
func (c *Client) ListVars(environmentID string) ([]Var, error) {
	var resp struct {
		Vars []Var `json:"vars"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/vars", environmentID), &resp); err != nil {
		return nil, err
	}
	return resp.Vars, nil
}

// CreateVar creates a var in an environment.
func (c *Client) CreateVar(environmentID string, req CreateVarRequest) (*Var, error) {
	var resp struct {
		Var Var `json:"var"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/vars", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Var, nil
}

// UpdateVar updates a var by ID.
func (c *Client) UpdateVar(id string, req UpdateVarRequest) (*Var, error) {
	var resp struct {
		Var Var `json:"var"`
	}
	if err := c.Patch(fmt.Sprintf("/api/vars/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Var, nil
}

// DeleteVar deletes a var by ID.
func (c *Client) DeleteVar(id string) error {
	return c.Delete(fmt.Sprintf("/api/vars/%s", id), nil)
}

// GetVarByKey finds a var by its key within an environment (for import).
func (c *Client) GetVarByKey(environmentID, key string) (*Var, error) {
	vars, err := c.ListVars(environmentID)
	if err != nil {
		return nil, err
	}
	for i := range vars {
		if vars[i].Key == key {
			return &vars[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("var '%s' not found", key)}
}
