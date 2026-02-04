package collector

import (
	"crypto/tls"
	"fmt"
	"net"
	"time"
)

// TCPCheckConfig defines a TCP port to check
type TCPCheckConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Name string `json:"name"` // Optional label
}

// TCPCheckResult contains the result of a TCP connectivity check
type TCPCheckResult struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Name       string `json:"name,omitempty"`
	Success    bool   `json:"success"`
	DurationMs int    `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

// CertCheckConfig defines a TLS endpoint to check certificate expiry
type CertCheckConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Name string `json:"name"` // Optional label
}

// CertCheckResult contains the result of a certificate expiry check
type CertCheckResult struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Name           string `json:"name,omitempty"`
	Success        bool   `json:"success"`
	DurationMs     int    `json:"durationMs"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	DaysUntilExpiry int    `json:"daysUntilExpiry,omitempty"`
	Issuer         string `json:"issuer,omitempty"`
	Subject        string `json:"subject,omitempty"`
	Error          string `json:"error,omitempty"`
}

// CheckTCPPorts performs TCP connectivity checks on the given targets
func CheckTCPPorts(targets []TCPCheckConfig, timeout time.Duration) []TCPCheckResult {
	if timeout == 0 {
		timeout = 5 * time.Second
	}

	results := make([]TCPCheckResult, 0, len(targets))

	for _, target := range targets {
		result := TCPCheckResult{
			Host: target.Host,
			Port: target.Port,
			Name: target.Name,
		}

		addr := fmt.Sprintf("%s:%d", target.Host, target.Port)
		start := time.Now()

		conn, err := net.DialTimeout("tcp", addr, timeout)
		result.DurationMs = int(time.Since(start).Milliseconds())

		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Success = true
			conn.Close()
		}

		results = append(results, result)
	}

	return results
}

// CheckCertificates performs TLS certificate expiry checks on the given targets
func CheckCertificates(targets []CertCheckConfig, timeout time.Duration) []CertCheckResult {
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	results := make([]CertCheckResult, 0, len(targets))

	for _, target := range targets {
		result := CertCheckResult{
			Host: target.Host,
			Port: target.Port,
			Name: target.Name,
		}

		addr := fmt.Sprintf("%s:%d", target.Host, target.Port)
		start := time.Now()

		// Configure TLS with InsecureSkipVerify to get cert info even for self-signed certs
		dialer := &net.Dialer{Timeout: timeout}
		conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			InsecureSkipVerify: true,
		})
		result.DurationMs = int(time.Since(start).Milliseconds())

		if err != nil {
			result.Success = false
			result.Error = err.Error()
			results = append(results, result)
			continue
		}
		defer conn.Close()

		// Get certificate info
		certs := conn.ConnectionState().PeerCertificates
		if len(certs) == 0 {
			result.Success = false
			result.Error = "no certificates found"
			results = append(results, result)
			continue
		}

		// Use the first (leaf) certificate
		cert := certs[0]
		result.Success = true
		result.ExpiresAt = cert.NotAfter.UTC().Format(time.RFC3339)
		result.DaysUntilExpiry = int(time.Until(cert.NotAfter).Hours() / 24)
		result.Issuer = cert.Issuer.CommonName
		result.Subject = cert.Subject.CommonName

		// Mark as warning if expiring soon (within 30 days)
		if result.DaysUntilExpiry < 0 {
			result.Success = false
			result.Error = "certificate has expired"
		}

		results = append(results, result)
	}

	return results
}

// ContainerHealthStatus represents Docker's native HEALTHCHECK result
type ContainerHealthStatus struct {
	ContainerName string `json:"containerName"`
	Status        string `json:"status"` // healthy, unhealthy, starting, none
	FailingStreak int    `json:"failingStreak,omitempty"`
	Log           string `json:"log,omitempty"` // Last health check log output
}

// GetContainerHealthStatus extracts health status from container inspect data
// This is called from the docker collector when inspect data is available
func GetContainerHealthStatus(containerName string, healthData map[string]interface{}) ContainerHealthStatus {
	result := ContainerHealthStatus{
		ContainerName: containerName,
		Status:        "none",
	}

	if healthData == nil {
		return result
	}

	if status, ok := healthData["Status"].(string); ok {
		result.Status = status
	}

	if failingStreak, ok := healthData["FailingStreak"].(float64); ok {
		result.FailingStreak = int(failingStreak)
	}

	// Get the last log entry if available
	if logs, ok := healthData["Log"].([]interface{}); ok && len(logs) > 0 {
		if lastLog, ok := logs[len(logs)-1].(map[string]interface{}); ok {
			if output, ok := lastLog["Output"].(string); ok {
				// Truncate long output
				if len(output) > 200 {
					output = output[:200] + "..."
				}
				result.Log = output
			}
		}
	}

	return result
}
