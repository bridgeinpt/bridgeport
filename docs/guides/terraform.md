# Terraform / OpenTofu Provider

Manage BRIDGEPORT configuration declaratively — environments, servers, vars/secrets, config files & fragments, registry connections, container images, and service templates & deployments — with the official [`terraform-provider-bridgeport`](https://github.com/bridgeinpt/terraform-provider-bridgeport). Desired state lives in version control, changes ship through review, and configuration that drifts out-of-band shows up in `terraform plan`.

## Table of Contents

- [Overview](#overview)
- [Where it lives](#where-it-lives)
- [Quick Start](#quick-start)
- [Design model](#design-model)
- [What you can manage](#what-you-can-manage)
- [Versioning & compatibility](#versioning--compatibility)
- [Related](#related)

---

## Overview

BRIDGEPORT sits between infrastructure (typically already provisioned with IaC) and the services running on it. The provider closes that loop: the same `terraform`/`tofu` workflow that creates your servers can declare what BRIDGEPORT should know about them.

The provider is published to **both** registries:

| Registry | Page | `source` |
|---|---|---|
| Terraform Registry | [registry.terraform.io/providers/bridgeinpt/bridgeport](https://registry.terraform.io/providers/bridgeinpt/bridgeport) | `bridgeinpt/bridgeport` |
| OpenTofu Registry | [search.opentofu.org/provider/bridgeinpt/bridgeport](https://search.opentofu.org/provider/bridgeinpt/bridgeport) | `bridgeinpt/bridgeport` |

Releases are GPG-signed; `terraform`/`tofu init` verifies the signature against the registered key automatically.

## Where it lives

The provider is maintained in a **separate repository** — [`bridgeinpt/terraform-provider-bridgeport`](https://github.com/bridgeinpt/terraform-provider-bridgeport) — because the Terraform and OpenTofu registries hard-require the `terraform-provider-*` repo naming and consume that repo's GitHub releases, and because the provider has its own semver line (one provider release supports a *range* of BRIDGEPORT versions).

The contract that keeps the two in lockstep lives in **this** repo: a typed, checked-in [OpenAPI spec](../reference/api.md), the [API stability & deprecation policy](../api-stability.md), and an importable Go SDK (`client/`) updated alongside any API change. Full provider reference docs (every resource and data source) are generated in the provider repo and on the registry pages above.

## Quick Start

```hcl
terraform {
  required_providers {
    bridgeport = {
      source  = "bridgeinpt/bridgeport"
      version = "~> 0.1"
    }
  }
}

provider "bridgeport" {
  endpoint = "https://bridgeport.example.com" # or BRIDGEPORT_URL
  token    = var.bridgeport_token             # or BRIDGEPORT_TOKEN
}

# Negotiate against the target instance's version
data "bridgeport_version" "this" {}

resource "bridgeport_server" "web" {
  environment = "production"
  name        = "web-1"
  hostname    = "10.0.0.5"
  tags        = ["web"]
}
```

Generate a token under **Service Accounts** (recommended for automation) or via `bridgeport login`. Scope it to the environments the configuration manages.

## Design model

The provider follows a few deliberate tenets — useful to know before you reach for it:

- **Configuration only — runtime stays imperative.** Deploys, restarts, and rollbacks remain UI/API/CLI operations. Runtime fields (`status`, exposed ports, health, discovery) are read-only `Computed` attributes, never inputs.
- **Secrets never enter Terraform state.** Secret values are write-only arguments paired with a version attribute that triggers rotation, matching the API's write-only secret values. Registry credentials behave the same way.
- **`plan` works offline.** Managed resources diff against your submitted configuration, not against live runtime state, so a `plan` doesn't depend on a reachable instance. (Data sources, by contrast, are *read* during plan — e.g. `bridgeport_version` calls `/health`.)
- **Natural-key import.** `terraform import` keys on `environment` + `name`/`key`, so existing resources adopt cleanly.

## What you can manage

**Resources** (config-only CRUD): `bridgeport_server`, `bridgeport_var`, `bridgeport_secret`, `bridgeport_config_fragment`, `bridgeport_config_file`, `bridgeport_registry_connection`, `bridgeport_container_image`, `bridgeport_service`, `bridgeport_service_deployment`.

**Data sources**: `bridgeport_environment`, `bridgeport_server(s)`, `bridgeport_service(s)`, and `bridgeport_version` (instance status + app/agent/CLI versions, for version negotiation and `precondition` assertions).

## Versioning & compatibility

The provider has its own semver line, independent of the BRIDGEPORT platform release. It talks to the instance over the stable HTTP API (see the [API Stability Policy](../api-stability.md)), and the provider's acceptance suite runs against the published Docker image in CI, so a provider release is validated against the platform it claims to support. Pin the provider with `version = "~> X.Y"` and let `terraform init` upgrade within the range.

## Related

- [API Stability Policy](../api-stability.md) — the compatibility contract the provider depends on
- [API Reference](../reference/api.md) — the underlying REST API and OpenAPI spec
- [Service Accounts & API Tokens](users.md) — generating a scoped token for automation
- [`terraform-provider-bridgeport`](https://github.com/bridgeinpt/terraform-provider-bridgeport) — provider source, full resource/data-source docs, and issues
