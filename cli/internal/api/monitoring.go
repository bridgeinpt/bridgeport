package api

import "fmt"

type HealthLog struct {
	ID           string  `json:"id"`
	ResourceType string  `json:"resourceType"`
	ResourceName string  `json:"resourceName"`
	CheckType    string  `json:"checkType"`
	Status       string  `json:"status"`
	DurationMs   *int    `json:"durationMs"`
	ErrorMessage *string `json:"errorMessage"`
	CreatedAt    string  `json:"createdAt"`
}

type HealthLogResponse struct {
	Logs       []HealthLog `json:"logs"`
	Total      int         `json:"total"`
	Page       int         `json:"page"`
	Limit      int         `json:"limit"`
	TotalPages int         `json:"totalPages"`
}

// ListHealthLogs returns health check logs for an environment
func (c *Client) ListHealthLogs(environmentID string, params map[string]string) (*HealthLogResponse, error) {
	path := fmt.Sprintf("/api/environments/%s/health-logs", environmentID)

	query := ""
	for k, v := range params {
		if v != "" {
			if query == "" {
				query = "?"
			} else {
				query += "&"
			}
			query += k + "=" + v
		}
	}

	var response HealthLogResponse
	if err := c.Get(path+query, &response); err != nil {
		return nil, err
	}
	return &response, nil
}
