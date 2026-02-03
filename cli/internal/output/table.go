package output

import (
	"os"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
)

var (
	// Colors
	Green  = color.New(color.FgGreen).SprintFunc()
	Yellow = color.New(color.FgYellow).SprintFunc()
	Red    = color.New(color.FgRed).SprintFunc()
	Cyan   = color.New(color.FgCyan).SprintFunc()
	Bold   = color.New(color.Bold).SprintFunc()
)

// DisableColors disables all color output
func DisableColors() {
	color.NoColor = true
}

// NewTable creates a new formatted table
func NewTable(headers []string) *tablewriter.Table {
	table := tablewriter.NewWriter(os.Stdout)
	table.SetHeader(headers)
	table.SetBorder(false)
	table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	table.SetAlignment(tablewriter.ALIGN_LEFT)
	table.SetCenterSeparator("")
	table.SetColumnSeparator("")
	table.SetRowSeparator("")
	table.SetHeaderLine(false)
	table.SetTablePadding("  ")
	table.SetNoWhiteSpace(true)
	return table
}

// StatusColor returns a colored status string
func StatusColor(status string) string {
	switch status {
	case "healthy", "running", "up", "online":
		return Green(status)
	case "unhealthy", "error", "failed", "down", "offline":
		return Red(status)
	case "starting", "stopping", "pending", "unknown":
		return Yellow(status)
	default:
		return status
	}
}

// HealthColor returns a colored health status
func HealthColor(health string) string {
	switch health {
	case "healthy":
		return Green(health)
	case "unhealthy":
		return Red(health)
	default:
		return Yellow(health)
	}
}

// FormatPercent formats a percentage with color based on value
func FormatPercent(value float64) string {
	formatted := formatPercentValue(value)
	if value >= 90 {
		return Red(formatted)
	} else if value >= 70 {
		return Yellow(formatted)
	}
	return Green(formatted)
}

func formatPercentValue(value float64) string {
	if value < 10 {
		return " " + formatFloat(value) + "%"
	}
	return formatFloat(value) + "%"
}

func formatFloat(value float64) string {
	if value == float64(int(value)) {
		return formatInt(int(value))
	}
	return formatFloatWithDecimals(value, 1)
}

func formatInt(v int) string {
	return string(rune('0'+v/10)) + string(rune('0'+v%10))
}

func formatFloatWithDecimals(v float64, decimals int) string {
	intPart := int(v)
	decPart := int((v - float64(intPart)) * 10)
	if decimals == 1 {
		return string(rune('0'+intPart/10)) + string(rune('0'+intPart%10)) + "." + string(rune('0'+decPart))
	}
	return ""
}

// FormatUptime formats uptime in human-readable form
func FormatUptime(seconds int64) string {
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	minutes := (seconds % 3600) / 60

	if days > 0 {
		return formatDaysHours(days, hours)
	} else if hours > 0 {
		return formatHoursMinutes(hours, minutes)
	}
	return formatMinutes(minutes)
}

func formatDaysHours(days, hours int64) string {
	if days == 1 {
		return "1 day"
	}
	return formatInt64(days) + " days"
}

func formatHoursMinutes(hours, minutes int64) string {
	if hours == 1 {
		return "1 hour"
	}
	return formatInt64(hours) + " hours"
}

func formatMinutes(minutes int64) string {
	if minutes <= 1 {
		return "< 1 min"
	}
	return formatInt64(minutes) + " mins"
}

func formatInt64(v int64) string {
	if v < 10 {
		return string(rune('0' + v))
	}
	result := ""
	for v > 0 {
		result = string(rune('0'+v%10)) + result
		v /= 10
	}
	return result
}

// FormatBytes formats bytes in human-readable form
func FormatBytes(mb int64) string {
	if mb >= 1024 {
		gb := float64(mb) / 1024.0
		return formatFloatGB(gb) + " GB"
	}
	return formatInt64(mb) + " MB"
}

func formatFloatGB(v float64) string {
	intPart := int(v)
	decPart := int((v - float64(intPart)) * 10)
	return formatIntValue(intPart) + "." + string(rune('0'+decPart))
}

func formatIntValue(v int) string {
	if v < 10 {
		return string(rune('0' + v))
	}
	result := ""
	for v > 0 {
		result = string(rune('0'+v%10)) + result
		v /= 10
	}
	return result
}
