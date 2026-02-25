# Security Policy

BridgePort takes security seriously. This document describes how to report vulnerabilities and what to expect from us.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Instead, email us at **security@bridgein.pt** with:

1. A description of the vulnerability
2. Steps to reproduce (or a proof-of-concept)
3. The potential impact as you understand it
4. Your name or handle for attribution (optional)

### What to Report

- Authentication or authorization bypasses
- Encryption weaknesses in secret storage
- SQL injection or other injection attacks
- Cross-site scripting (XSS) in the web UI
- Server-side request forgery (SSRF)
- Privilege escalation between roles (viewer, operator, admin)
- Exposure of encrypted secrets, SSH keys, or credentials
- Agent token leakage or impersonation

### What Is Not a Vulnerability

- Denial of service against a self-hosted instance you control
- Social engineering attacks
- Issues requiring physical access to the server
- Missing HTTP security headers on a non-HTTPS deployment (use a reverse proxy)

## Response Timeline

| Step | Timeline |
|------|----------|
| Acknowledgment of your report | Within 2 business days |
| Initial assessment and severity triage | Within 5 business days |
| Fix developed and tested | Depends on severity (see below) |
| Fix released | Alongside the patch release |
| Public disclosure | After the fix is released, coordinated with reporter |

**Severity-based fix timelines:**

- **Critical** (auth bypass, secret exposure): Target fix within 48 hours
- **High** (privilege escalation, injection): Target fix within 7 days
- **Medium** (information disclosure, CSRF): Target fix within 30 days
- **Low** (minor issues): Addressed in the next regular release

## Supported Versions

BridgePort follows a rolling release model. We support the **latest release** with security patches.

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Previous releases | Best effort, critical vulnerabilities only |

We recommend always running the latest version. Upgrades are designed to be seamless -- pull the new image, restart, and migrations apply automatically. See the [Upgrade Guide](docs/operations/upgrades.md).

## Security Architecture

BridgePort includes several security features by default:

- **Encryption at rest**: Secrets, SSH keys, and registry credentials are encrypted with XChaCha20-Poly1305 using the `MASTER_KEY`
- **Authentication**: JWT tokens with bcrypt password hashing, plus API tokens for programmatic access
- **Authorization**: Role-based access control with three tiers (admin, operator, viewer)
- **Audit logging**: All sensitive operations are logged with user, action, and timestamp
- **Per-environment isolation**: SSH keys, secrets, and settings are scoped to environments

For the full security architecture and production hardening checklist, see [docs/operations/security.md](docs/operations/security.md).

## Security Configuration Recommendations

When deploying BridgePort in production:

- [ ] Run behind a reverse proxy with HTTPS (Caddy, Nginx, or Traefik)
- [ ] Generate strong, unique values for `MASTER_KEY` and `JWT_SECRET`
- [ ] Change the default admin credentials immediately after first login
- [ ] Set `CORS_ORIGIN` to your specific domain(s)
- [ ] Restrict network access to the BridgePort port (3000) via firewall rules
- [ ] Use the Docker socket mount only in trusted environments (it provides root-equivalent access)
- [ ] Back up your `MASTER_KEY` securely and separately from the database -- without it, encrypted data cannot be recovered
- [ ] Review audit logs periodically for unexpected activity

## Acknowledgments

We gratefully acknowledge security researchers who help keep BridgePort secure. With your permission, we will list your name or handle here after coordinated disclosure.

## Contact

- **Security reports**: security@bridgein.pt
- **General questions**: [GitHub Discussions](https://github.com/bridgeinpt/bridgeport/discussions)
