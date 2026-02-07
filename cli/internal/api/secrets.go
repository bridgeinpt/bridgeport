package api

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
