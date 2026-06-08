# BRIDGEPORT Go Client

`github.com/bridgeinpt/bridgeport/client` is the Go SDK for the [BRIDGEPORT](https://github.com/bridgeinpt/bridgeport) HTTP API.

## Install

```bash
go get github.com/bridgeinpt/bridgeport/client@latest
```

## Authentication

Construct a client with your server URL and an API bearer token:

```go
c := client.NewClient("https://bridgeport.example.com", "<api-token>")
```

The token is sent as a `Bearer` token on every request. Generate one in BRIDGEPORT
under Service Accounts (recommended for automation) or via `bridgeport login`.

## Error handling

API calls return a `*APIError` when the server responds with an HTTP status >= 400.
It carries the HTTP status code and the server's message:

```go
type APIError struct {
    StatusCode int
    Message    string
}
```

Use `errors.As` to inspect it:

```go
var apiErr *client.APIError
if errors.As(err, &apiErr) {
    if apiErr.StatusCode == http.StatusUnauthorized {
        // token is missing or invalid
    }
}
```

## Example

```go
package main

import (
    "errors"
    "fmt"
    "log"
    "net/http"

    "github.com/bridgeinpt/bridgeport/client"
)

func main() {
    c := client.NewClient("https://bridgeport.example.com", "<api-token>")

    user, err := c.GetCurrentUser()
    if err != nil {
        var apiErr *client.APIError
        if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusUnauthorized {
            log.Fatal("authentication failed: check your token")
        }
        log.Fatalf("request failed: %v", err)
    }

    fmt.Printf("Authenticated as %s (%s)\n", user.Email, user.Role)
}
```

Other read methods follow the same shape, e.g. `c.ListEnvironments()`,
`c.ListServers(environmentID)`, and `c.ListServices(serverID)`.
