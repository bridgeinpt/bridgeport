package client

import "fmt"

type Secret struct {
	ID          string  `json:"id"`
	Key         string  `json:"key"`
	Description *string `json:"description"`
	NeverReveal bool    `json:"neverReveal"`
	UsageCount  int     `json:"usageCount"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// ListSecrets returns all secrets for an environment (names only, no values)
func (c *Client) ListSecrets(environmentID string) ([]Secret, error) {
	var response struct {
		Secrets []Secret `json:"secrets"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/secrets", environmentID), &response); err != nil {
		return nil, err
	}
	return response.Secrets, nil
}

// CreateSecretRequest is the body for POST /api/environments/:envId/secrets.
// Key must match /^[A-Z][A-Z0-9_]*$/. Value is write-only — it is never
// returned by any read endpoint.
type CreateSecretRequest struct {
	Key         string  `json:"key"`
	Value       string  `json:"value"`
	Description *string `json:"description,omitempty"`
	NeverReveal *bool   `json:"neverReveal,omitempty"`
}

// UpdateSecretRequest is the body for PATCH /api/secrets/:id. Supplying Value
// rotates the secret in place (no version history).
type UpdateSecretRequest struct {
	Value       *string `json:"value,omitempty"`
	Description *string `json:"description,omitempty"`
	NeverReveal *bool   `json:"neverReveal,omitempty"`
}

// CreateSecret creates a secret in an environment (natural key: environment + key).
// The returned Secret never carries the value.
func (c *Client) CreateSecret(environmentID string, req CreateSecretRequest) (*Secret, error) {
	var resp struct {
		Secret Secret `json:"secret"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/secrets", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Secret, nil
}

// UpdateSecret updates a secret by ID.
func (c *Client) UpdateSecret(id string, req UpdateSecretRequest) (*Secret, error) {
	var resp struct {
		Secret Secret `json:"secret"`
	}
	if err := c.Patch(fmt.Sprintf("/api/secrets/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.Secret, nil
}

// DeleteSecret deletes a secret by ID.
func (c *Client) DeleteSecret(id string) error {
	return c.Delete(fmt.Sprintf("/api/secrets/%s", id), nil)
}

// GetSecretByKey finds a secret by its key within an environment (for import).
// The value is not included.
func (c *Client) GetSecretByKey(environmentID, key string) (*Secret, error) {
	secrets, err := c.ListSecrets(environmentID)
	if err != nil {
		return nil, err
	}
	for i := range secrets {
		if secrets[i].Key == key {
			return &secrets[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, Message: fmt.Sprintf("secret '%s' not found", key)}
}
