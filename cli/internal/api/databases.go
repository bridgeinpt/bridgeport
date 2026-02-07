package api

import "fmt"

type Database struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Type             string  `json:"type"`
	Host             *string `json:"host"`
	Port             *int    `json:"port"`
	DatabaseName     *string `json:"databaseName"`
	MonitoringEnabled bool   `json:"monitoringEnabled"`
	MonitoringStatus  string `json:"monitoringStatus"`
	BackupStorageType string `json:"backupStorageType"`
	EnvironmentID    string  `json:"environmentId"`
	ServerID         *string `json:"serverId"`
	CreatedAt        string  `json:"createdAt"`
}

type DatabaseBackup struct {
	ID          string  `json:"id"`
	Filename    string  `json:"filename"`
	Size        int64   `json:"size"`
	Type        string  `json:"type"`
	Status      string  `json:"status"`
	Error       *string `json:"error"`
	StorageType string  `json:"storageType"`
	Duration    *int    `json:"duration"`
	CreatedAt   string  `json:"createdAt"`
	CompletedAt *string `json:"completedAt"`
	DatabaseID  string  `json:"databaseId"`
}

// ListDatabases returns all databases for an environment
func (c *Client) ListDatabases(environmentID string) ([]Database, error) {
	var response struct {
		Databases []Database `json:"databases"`
	}
	if err := c.Get(fmt.Sprintf("/api/environments/%s/databases", environmentID), &response); err != nil {
		return nil, err
	}
	return response.Databases, nil
}

// ListDatabaseBackups returns backups for a database
func (c *Client) ListDatabaseBackups(databaseID string, limit int) ([]DatabaseBackup, error) {
	var response struct {
		Backups []DatabaseBackup `json:"backups"`
		Total   int              `json:"total"`
	}
	path := fmt.Sprintf("/api/databases/%s/backups?limit=%d", databaseID, limit)
	if err := c.Get(path, &response); err != nil {
		return nil, err
	}
	return response.Backups, nil
}
