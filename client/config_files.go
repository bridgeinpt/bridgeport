package client

import "fmt"

type ConfigFile struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Filename      string  `json:"filename"`
	Description   *string `json:"description"`
	Content       string  `json:"content,omitempty"` // empty for binary files
	IsBinary      bool    `json:"isBinary"`
	MimeType      *string `json:"mimeType,omitempty"`
	FileSize      *int64  `json:"fileSize"`
	AutoResync    bool    `json:"autoResync,omitempty"`
	Language      string  `json:"language,omitempty"`
	EnvironmentID string  `json:"environmentId,omitempty"`
	SyncStatus    string  `json:"syncStatus,omitempty"` // list/detail only
	SyncCounts    struct {
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

// GetConfigFile returns a single config file (with content) by ID.
func (c *Client) GetConfigFile(id string) (*ConfigFile, error) {
	var resp struct {
		ConfigFile ConfigFile `json:"configFile"`
	}
	if err := c.Get(fmt.Sprintf("/api/config-files/%s", id), &resp); err != nil {
		return nil, err
	}
	return &resp.ConfigFile, nil
}

// CreateConfigFileRequest is the body for POST /api/environments/:envId/config-files.
// FragmentIDs are ordered; position is the array index. Binary files cannot
// include fragments.
type CreateConfigFileRequest struct {
	Name        string   `json:"name"`
	Filename    string   `json:"filename"`
	Content     string   `json:"content"`
	Description *string  `json:"description,omitempty"`
	IsBinary    *bool    `json:"isBinary,omitempty"`
	MimeType    *string  `json:"mimeType,omitempty"`
	FileSize    *int64   `json:"fileSize,omitempty"`
	AutoResync  *bool    `json:"autoResync,omitempty"`
	Language    *string  `json:"language,omitempty"`
	FragmentIDs []string `json:"fragmentIds,omitempty"`
}

// UpdateConfigFileRequest is the body for PATCH /api/config-files/:id. When
// FragmentIDs is provided it fully replaces the file's included fragments (in
// order); omit it to leave them unchanged.
type UpdateConfigFileRequest struct {
	Name        *string  `json:"name,omitempty"`
	Filename    *string  `json:"filename,omitempty"`
	Content     *string  `json:"content,omitempty"`
	Description *string  `json:"description,omitempty"`
	IsBinary    *bool    `json:"isBinary,omitempty"`
	MimeType    *string  `json:"mimeType,omitempty"`
	FileSize    *int64   `json:"fileSize,omitempty"`
	AutoResync  *bool    `json:"autoResync,omitempty"`
	Language    *string  `json:"language,omitempty"`
	FragmentIDs []string `json:"fragmentIds,omitempty"`
}

// CreateConfigFile creates a config file (natural key: environment + name).
func (c *Client) CreateConfigFile(environmentID string, req CreateConfigFileRequest) (*ConfigFile, error) {
	var resp struct {
		ConfigFile ConfigFile `json:"configFile"`
	}
	if err := c.Post(fmt.Sprintf("/api/environments/%s/config-files", environmentID), req, &resp); err != nil {
		return nil, err
	}
	return &resp.ConfigFile, nil
}

// UpdateConfigFile updates a config file by ID.
func (c *Client) UpdateConfigFile(id string, req UpdateConfigFileRequest) (*ConfigFile, error) {
	var resp struct {
		ConfigFile ConfigFile `json:"configFile"`
	}
	if err := c.Patch(fmt.Sprintf("/api/config-files/%s", id), req, &resp); err != nil {
		return nil, err
	}
	return &resp.ConfigFile, nil
}

// DeleteConfigFile deletes a config file by ID.
func (c *Client) DeleteConfigFile(id string) error {
	return c.Delete(fmt.Sprintf("/api/config-files/%s", id), nil)
}
