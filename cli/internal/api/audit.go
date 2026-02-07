package api

type AuditLog struct {
	ID           string  `json:"id"`
	Action       string  `json:"action"`
	ResourceType string  `json:"resourceType"`
	ResourceName *string `json:"resourceName"`
	Success      bool    `json:"success"`
	CreatedAt    string  `json:"createdAt"`
	User         *struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	Environment *struct {
		Name string `json:"name"`
	} `json:"environment"`
}

// ListAuditLogs returns audit logs with optional filters
func (c *Client) ListAuditLogs(params map[string]string) ([]AuditLog, int, error) {
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

	var response struct {
		Logs  []AuditLog `json:"logs"`
		Total int        `json:"total"`
	}
	if err := c.Get("/api/audit-logs"+query, &response); err != nil {
		return nil, 0, err
	}
	return response.Logs, response.Total, nil
}
