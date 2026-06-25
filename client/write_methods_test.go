package client

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// decodeBody reads the request JSON body into a generic map for assertions.
func decodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	raw, err := io.ReadAll(r.Body)
	require.NoError(t, err)
	if len(raw) == 0 {
		return map[string]any{}
	}
	var m map[string]any
	require.NoError(t, json.Unmarshal(raw, &m))
	return m
}

func TestCreateServer(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "/api/environments/env-1/servers", r.URL.Path)
		body = decodeBody(t, r)
		json.NewEncoder(w).Encode(map[string]any{
			"server": map[string]any{"id": "srv-1", "name": "web", "hostname": "10.0.0.1", "environmentId": "env-1"},
		})
	}))
	defer ts.Close()

	c := NewClient(ts.URL, "tok")
	pub := "1.2.3.4"
	srv, err := c.CreateServer("env-1", CreateServerRequest{
		Name: "web", Hostname: "10.0.0.1", PublicIP: &pub, Tags: []string{"web"},
	})
	require.NoError(t, err)
	assert.Equal(t, "srv-1", srv.ID)
	assert.Equal(t, "10.0.0.1", srv.Hostname)
	// request serialization
	assert.Equal(t, "web", body["name"])
	assert.Equal(t, "10.0.0.1", body["hostname"])
	assert.Equal(t, "1.2.3.4", body["publicIp"])
	assert.Equal(t, []any{"web"}, body["tags"])
}

func TestUpdateServerOmitsUnsetFields(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "PATCH", r.Method)
		assert.Equal(t, "/api/servers/srv-1", r.URL.Path)
		body = decodeBody(t, r)
		json.NewEncoder(w).Encode(map[string]any{"server": map[string]any{"id": "srv-1", "name": "renamed"}})
	}))
	defer ts.Close()

	c := NewClient(ts.URL, "tok")
	name := "renamed"
	srv, err := c.UpdateServer("srv-1", UpdateServerRequest{Name: &name})
	require.NoError(t, err)
	assert.Equal(t, "renamed", srv.Name)
	assert.Equal(t, "renamed", body["name"])
	_, hasHostname := body["hostname"]
	assert.False(t, hasHostname, "unset optional fields must be omitted")
}

func TestDeleteServer(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "DELETE", r.Method)
		assert.Equal(t, "/api/servers/srv-1", r.URL.Path)
		json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer ts.Close()

	require.NoError(t, NewClient(ts.URL, "tok").DeleteServer("srv-1"))
}

func TestCreateVar(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "/api/environments/env-1/vars", r.URL.Path)
		body = decodeBody(t, r)
		json.NewEncoder(w).Encode(map[string]any{
			"var": map[string]any{"id": "var-1", "key": "LOG_LEVEL", "value": "debug"},
		})
	}))
	defer ts.Close()

	v, err := NewClient(ts.URL, "tok").CreateVar("env-1", CreateVarRequest{Key: "LOG_LEVEL", Value: "debug"})
	require.NoError(t, err)
	assert.Equal(t, "debug", v.Value)
	assert.Equal(t, "LOG_LEVEL", body["key"])
	assert.Equal(t, "debug", body["value"])
}

func TestCreateSecretValueNotReturned(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1/secrets", r.URL.Path)
		body = decodeBody(t, r)
		// API never echoes the value
		json.NewEncoder(w).Encode(map[string]any{
			"secret": map[string]any{"id": "sec-1", "key": "DB_PASSWORD", "neverReveal": false},
		})
	}))
	defer ts.Close()

	never := true
	s, err := NewClient(ts.URL, "tok").CreateSecret("env-1", CreateSecretRequest{
		Key: "DB_PASSWORD", Value: "s3cr3t", NeverReveal: &never,
	})
	require.NoError(t, err)
	assert.Equal(t, "sec-1", s.ID)
	assert.Equal(t, "s3cr3t", body["value"], "value is sent in the request")
	assert.Equal(t, true, body["neverReveal"])
}

func TestCreateConfigFileWithFragments(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1/config-files", r.URL.Path)
		body = decodeBody(t, r)
		json.NewEncoder(w).Encode(map[string]any{
			"configFile": map[string]any{"id": "cf-1", "name": "nginx", "filename": "nginx.conf", "content": "server {}"},
		})
	}))
	defer ts.Close()

	cf, err := NewClient(ts.URL, "tok").CreateConfigFile("env-1", CreateConfigFileRequest{
		Name: "nginx", Filename: "nginx.conf", Content: "server {}", FragmentIDs: []string{"frag-1", "frag-2"},
	})
	require.NoError(t, err)
	assert.Equal(t, "server {}", cf.Content)
	assert.Equal(t, []any{"frag-1", "frag-2"}, body["fragmentIds"])
}

func TestCreateConfigFragment(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1/config-fragments", r.URL.Path)
		json.NewEncoder(w).Encode(map[string]any{
			"fragment": map[string]any{"id": "frag-1", "name": "common-headers", "content": "X-Foo: bar"},
		})
	}))
	defer ts.Close()

	f, err := NewClient(ts.URL, "tok").CreateConfigFragment("env-1", CreateConfigFragmentRequest{
		Name: "common-headers", Content: "X-Foo: bar",
	})
	require.NoError(t, err)
	assert.Equal(t, "frag-1", f.ID)
	assert.Equal(t, "X-Foo: bar", f.Content)
}

func TestCreateRegistryCredentialsWriteOnly(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1/registries", r.URL.Path)
		body = decodeBody(t, r)
		// Response exposes only hasToken/hasPassword, never the secrets.
		json.NewEncoder(w).Encode(map[string]any{
			"registry": map[string]any{"id": "reg-1", "name": "ghcr", "type": "generic", "registryUrl": "ghcr.io", "hasPassword": true},
		})
	}))
	defer ts.Close()

	pw := "pat-xxx"
	reg, err := NewClient(ts.URL, "tok").CreateRegistry("env-1", CreateRegistryRequest{
		Name: "ghcr", Type: "generic", RegistryURL: "ghcr.io", Username: strptr("me"), Password: &pw,
	})
	require.NoError(t, err)
	assert.True(t, reg.HasPassword)
	assert.Equal(t, "pat-xxx", body["password"], "password sent in request")
}

func TestCreateContainerImageDefaultsTagServerSide(t *testing.T) {
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/environments/env-1/container-images", r.URL.Path)
		body = decodeBody(t, r)
		json.NewEncoder(w).Encode(map[string]any{
			"image": map[string]any{"id": "img-1", "name": "api", "imageName": "ghcr.io/acme/api", "tagFilter": "latest"},
		})
	}))
	defer ts.Close()

	img, err := NewClient(ts.URL, "tok").CreateContainerImage("env-1", CreateContainerImageRequest{
		Name: "api", ImageName: "ghcr.io/acme/api",
	})
	require.NoError(t, err)
	assert.Equal(t, "latest", img.TagFilter)
	_, hasTag := body["tagFilter"]
	assert.False(t, hasTag, "omitted tagFilter defaults server-side")
}

func TestCreateServiceAndDeployment(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/environments/env-1/services":
			assert.Equal(t, "POST", r.Method)
			body := decodeBody(t, r)
			assert.Equal(t, "api", body["name"])
			assert.Equal(t, "img-1", body["containerImageId"])
			json.NewEncoder(w).Encode(map[string]any{"service": map[string]any{"id": "svc-1", "name": "api"}})
		case "/api/services/svc-1/deployments":
			assert.Equal(t, "POST", r.Method)
			body := decodeBody(t, r)
			assert.Equal(t, "srv-1", body["serverId"])
			assert.Equal(t, "api-prod", body["containerName"])
			json.NewEncoder(w).Encode(map[string]any{
				"deployment": map[string]any{"id": "dep-1", "serviceId": "svc-1", "serverId": "srv-1", "containerName": "api-prod"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer ts.Close()

	c := NewClient(ts.URL, "tok")
	svc, err := c.CreateService("env-1", CreateServiceRequest{Name: "api", ContainerImageID: "img-1"})
	require.NoError(t, err)
	assert.Equal(t, "svc-1", svc.ID)

	dep, err := c.CreateDeployment("svc-1", CreateDeploymentRequest{ServerID: "srv-1", ContainerName: "api-prod"})
	require.NoError(t, err)
	assert.Equal(t, "dep-1", dep.ID)
	assert.Equal(t, "srv-1", dep.ServerID)
}

func TestAttachAndDetachConfigFile(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/services/svc-1/files":
			body := decodeBody(t, r)
			assert.Equal(t, "cf-1", body["configFileId"])
			assert.Equal(t, "/etc/app.conf", body["targetPath"])
			json.NewEncoder(w).Encode(map[string]any{
				"serviceFile": map[string]any{"id": "sf-1", "serviceId": "svc-1", "configFileId": "cf-1", "targetPath": "/etc/app.conf"},
			})
		case r.Method == "DELETE" && r.URL.Path == "/api/services/svc-1/files/cf-1":
			json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer ts.Close()

	c := NewClient(ts.URL, "tok")
	sf, err := c.AttachConfigFile("svc-1", AttachFileRequest{ConfigFileID: "cf-1", TargetPath: "/etc/app.conf"})
	require.NoError(t, err)
	assert.Equal(t, "sf-1", sf.ID)
	require.NoError(t, c.DetachConfigFile("svc-1", "cf-1"))
}

func TestDeleteReturnsAPIError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": "Cannot delete registry connection with 2 container image(s) attached"})
	}))
	defer ts.Close()

	err := NewClient(ts.URL, "tok").DeleteRegistry("reg-1")
	require.Error(t, err)
	var apiErr *APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.StatusCode)
}

func strptr(s string) *string { return &s }
