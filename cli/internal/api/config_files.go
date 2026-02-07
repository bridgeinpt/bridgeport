package api

import "fmt"

type ConfigFile struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Filename    string  `json:"filename"`
	Description *string `json:"description"`
	IsBinary    bool    `json:"isBinary"`
	FileSize    *int64  `json:"fileSize"`
	SyncStatus  string  `json:"syncStatus"`
	SyncCounts  struct {
		Synced  int `json:"synced"`
		Pending int `json:"pending"`
		Never   int `json:"never"`
		Total   int `json:"total"`
	} `json:"syncCounts"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// ListConfigFiles returns all config files for an environment
func (c *Client) ListConfigFiles(environmentID string) ([]ConfigFile, error) {
	var response struct {
		ConfigFiles []ConfigFile `json:"configFiles"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/config-files", environmentID), &response); err != nil {
		return nil, err
	}
	return response.ConfigFiles, nil
}
