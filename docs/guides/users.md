# Users & Roles

BridgePort uses a three-tier role system (admin, operator, viewer) with JWT sessions and API tokens to control who can view, operate, and administer the platform.

## Table of Contents

1. [Quick Start](#quick-start)
2. [How It Works](#how-it-works)
3. [Roles & Permissions](#roles--permissions)
4. [Managing Users (Admin)](#managing-users-admin)
5. [Self-Service Account](#self-service-account)
6. [API Tokens](#api-tokens)
7. [Initial Admin Setup](#initial-admin-setup)
8. [Active User Tracking](#active-user-tracking)
9. [Configuration Options](#configuration-options)
10. [Troubleshooting](#troubleshooting)
11. [Related](#related)

---

## Quick Start

After your first admin account exists (see [Initial Admin Setup](#initial-admin-setup)), create additional users in under a minute:

1. Navigate to **Admin > Users** (`/admin/users`).
2. Click **Add User**.
3. Enter email, password (8+ characters), optional name, and role.
4. Click **Create**.

The new user can log in immediately and receives a welcome notification.

---

## How It Works

BridgePort supports two authentication methods: **JWT sessions** for interactive browser use and **API tokens** for programmatic access. Both carry the user's role and grant the same permissions.

```mermaid
sequenceDiagram
    participant Client
    participant BridgePort
    participant DB

    alt Browser login
        Client->>BridgePort: POST /api/auth/login {email, password}
        BridgePort->>DB: Validate credentials (bcrypt)
        BridgePort-->>Client: JWT token (7-day expiry)
        Client->>BridgePort: GET /api/... (Authorization: Bearer <JWT>)
        BridgePort->>DB: Verify JWT, load user role
        Note over BridgePort,DB: lastActiveAt updated in background
    else API token
        Client->>BridgePort: GET /api/... (Authorization: Bearer <api-token>)
        BridgePort->>DB: Hash token, look up ApiToken record
        BridgePort->>DB: Check expiry, load user role
        Note over BridgePort,DB: lastUsedAt updated on token record
    end
    BridgePort->>BridgePort: Check role against route requirement
    BridgePort-->>Client: 200 OK / 403 Forbidden
```

**Authentication flow details:**

1. The `authenticate` plugin tries the `Authorization: Bearer` value as an **API token first** (hash lookup in the `ApiToken` table).
2. If no API token matches, it attempts **JWT verification**.
3. If neither succeeds, the request gets `401 Unauthorized`.
4. After authentication, route-level middleware (`requireAdmin`, `requireOperator`) checks the user's role.

JWTs expire after **7 days**. API tokens have optional expiry set at creation time.

---

## Roles & Permissions

BridgePort has three roles in strict hierarchy: **admin > operator > viewer**. Higher roles inherit all permissions of lower roles.

### Role Descriptions

| Role | Purpose | Typical User |
|------|---------|--------------|
| **viewer** | Read-only access to all resources in every environment | Stakeholders, on-call engineers, auditors |
| **operator** | Viewer permissions + operational actions (deploy, manage secrets, trigger backups) | Day-to-day platform engineers |
| **admin** | Full access including user management, environments, and system settings | Platform owners, team leads |

### Full Permissions Matrix

| Action | Admin | Operator | Viewer |
|--------|:-----:|:--------:|:------:|
| **View all resources** (servers, services, metrics, logs) | Yes | Yes | Yes |
| **View audit logs** | Yes | Yes | Yes |
| **View deployment history** | Yes | Yes | Yes |
| **Reveal secret values** | Yes | Yes* | Yes* |
| **Deploy services** | Yes | Yes | No |
| **Restart / stop / start containers** | Yes | Yes | No |
| **Run predefined commands** (shell, migrate) | Yes | Yes | No |
| **Manage secrets** (create, update, delete) | Yes | Yes | No |
| **Manage config files & sync** | Yes | Yes | No |
| **Manage databases & backups** | Yes | Yes | No |
| **Trigger health checks** | Yes | Yes | No |
| **Create / delete environments** | Yes | No | No |
| **Edit environment settings** | Yes | No | No |
| **Manage users** (create, edit roles, delete) | Yes | No | No |
| **Manage service types / database types** | Yes | No | No |
| **System settings** (SSH timeouts, webhook config) | Yes | No | No |
| **SMTP / Slack / webhook channel config** | Yes | No | No |
| **Delete servers** | Yes | No | No |

\* Secret reveal is subject to the per-environment `allowSecretReveal` setting and the per-secret `neverReveal` flag, both configured by admins.

> [!WARNING]
> An admin cannot change their own role. This prevents accidental self-demotion. Another admin must make the change.

---

## Managing Users (Admin)

All user management is under **Admin > Users** (`/admin/users`). These actions require the `admin` role.

### Creating a User

```http
POST /api/users
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "securepassword",
  "name": "Alice",
  "role": "operator"
}
```

**Response (200):**
```json
{
  "user": {
    "id": "clxyz...",
    "email": "alice@example.com",
    "name": "Alice",
    "role": "operator",
    "createdAt": "2026-02-25T10:00:00.000Z",
    "updatedAt": "2026-02-25T10:00:00.000Z"
  }
}
```

Validation: password must be 8+ characters, email must be unique (returns `409 Conflict` if taken). The new user receives a welcome notification.

> [!NOTE]
> Email addresses cannot be changed after creation. To change a user's email, delete the account and create a new one.

### Listing Users

```http
GET /api/users
Authorization: Bearer <admin-token>
```

Returns all users ordered by creation date (newest first). Each record includes `id`, `email`, `name`, `role`, `lastActiveAt`, `createdAt`, and `updatedAt`. Password hashes are never returned.

### Editing a User

Admins can update `name` and `role`. Email is immutable.

```http
PATCH /api/users/:id
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "role": "admin"
}
```

When a role changes, the affected user receives a notification: _"Your role has been changed from operator to admin."_

> [!NOTE]
> Non-admin users can call `PATCH /api/users/:id` on their own account to update their `name`. Including a `role` field is rejected with `403 Forbidden`.

### Resetting a User's Password

Admins can reset any user's password without knowing the current one:

```http
POST /api/users/:id/change-password
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "newPassword": "newSecurePassword"
}
```

The affected user receives a notification: _"Your password was changed by an administrator."_

### Deleting a User

```http
DELETE /api/users/:id
Authorization: Bearer <admin-token>
```

Returns `400 Bad Request` if you attempt to delete your own account. All related records (deployments, audit logs, API tokens, notifications) are cascade-deleted.

> [!WARNING]
> Deletion is permanent. There is no deactivation mechanism. If you need to revoke access without losing audit history, consider rotating the user's password and revoking all their API tokens instead.

---

## Self-Service Account

Every user, regardless of role, can manage their own profile without admin involvement.

### Accessing My Account

Click the **user icon** at the bottom of the left sidebar. The **My Account** modal opens with two sections:

- **Profile** -- update your display name (email and role are read-only)
- **Change Password** -- update your own password

### Changing Your Password

1. Enter your **Current Password**.
2. Enter your **New Password** (8+ characters).
3. Click **Change Password**.

```http
POST /api/users/:id/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentPassword": "oldPassword",
  "newPassword": "newPassword"
}
```

> [!NOTE]
> Non-admin users must provide `currentPassword`. Admins resetting another user's password can omit it.

---

## API Tokens

API tokens let scripts, CI/CD pipelines, and external tools authenticate as a specific user without exposing login credentials. Tokens carry the same role permissions as their owner.

### Creating a Token

```http
POST /api/auth/tokens
Authorization: Bearer <jwt-or-existing-token>
Content-Type: application/json

{
  "name": "GitHub Actions deploy",
  "expiresInDays": 90
}
```

**Response:**
```json
{
  "token": "bp_abc123...",
  "tokenRecord": {
    "id": "clxyz...",
    "name": "GitHub Actions deploy",
    "expiresAt": "2026-05-26T10:00:00.000Z",
    "createdAt": "2026-02-25T10:00:00.000Z"
  }
}
```

> [!WARNING]
> The full token value is returned **only once** at creation time. BridgePort stores only a SHA-256 hash. Copy it immediately and store it in your secrets manager. If lost, delete the token and create a new one.

`expiresInDays` is optional. Omitting it creates a non-expiring token.

### Listing Your Tokens

```http
GET /api/auth/tokens
Authorization: Bearer <token>
```

Returns all tokens belonging to the authenticated user. Each record includes `id`, `name`, `lastUsedAt`, `expiresAt`, and `createdAt`. The token hash is never returned.

### Revoking a Token

```http
DELETE /api/auth/tokens/:tokenId
Authorization: Bearer <token>
```

You can only delete your own tokens. Returns `404` if the token does not exist or belongs to another user.

### Using a Token

**HTTP header (most requests):**
```http
Authorization: Bearer bp_abc123...
```

**Query parameter (SSE connections):**
```
GET /api/events?token=bp_abc123...
```

The SSE query parameter approach exists because `EventSource` clients cannot set custom headers.

### Token Use Cases

| Use Case | Recommended Setup |
|----------|-------------------|
| CI/CD pipeline deploys | `operator`-role token with `expiresInDays: 90` |
| Read-only monitoring | `viewer`-role token, non-expiring |
| SSE event streams | Any role, pass via `?token=` query param |
| Infrastructure-as-code | Store in secrets manager, rotate on schedule |
| Webhook integrations | Dedicated `operator` token per integration |

> [!TIP]
> Name tokens descriptively (e.g., `"github-actions-staging"`, `"grafana-readonly"`) so they are easy to identify and revoke. The `lastUsedAt` field helps find stale tokens that can be cleaned up.

---

## Initial Admin Setup

On first boot, if no users exist, BridgePort creates an admin account from environment variables:

```bash
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password
```

The `bootstrapAdminUser()` function in `src/services/auth.ts` checks `prisma.user.count()` and only proceeds if zero users exist, making it safe to leave these variables set permanently.

If neither variable is set, use the one-time registration endpoint instead:

```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "securepassword",
  "name": "Admin"
}
```

This creates the user with the `admin` role and returns a JWT. It returns `403 Forbidden` if any user already exists, effectively disabling open registration after bootstrap.

> [!NOTE]
> `ADMIN_PASSWORD` must be at least 8 characters. `ADMIN_EMAIL` must be a valid email. Invalid values cause a startup failure.

---

## Active User Tracking

BridgePort tracks when users are actively using the application. On every **JWT-authenticated** request, the `lastActiveAt` field is updated in the background (fire-and-forget, no added latency).

### Viewing Active Users

In **Admin > Users**, the page header shows an active users summary. Individual user cards show a green "Online" badge for currently active users.

```http
GET /api/users/active
Authorization: Bearer <admin-token>
```

Returns users whose `lastActiveAt` is within the configured active window.

### Configuring the Active Window

The window is controlled by `activeUserWindowMin` in System Settings (default: **15 minutes**):

```http
PATCH /api/settings/system
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "activeUserWindowMin": 30
}
```

> [!NOTE]
> API token requests do **not** update `lastActiveAt`. Active user tracking reflects interactive browser sessions only.

---

## Configuration Options

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| `ADMIN_EMAIL` | Environment variable | -- | Email for auto-created admin on first boot |
| `ADMIN_PASSWORD` | Environment variable | -- | Password for auto-created admin on first boot |
| `activeUserWindowMin` | System Settings | `15` | Minutes of inactivity before a user is no longer "active" |
| `allowSecretReveal` | Environment Settings > Configuration | `true` | Whether non-admin users can reveal secret values |
| JWT expiry | Hardcoded | `7 days` | JWT token lifetime |

---

## Troubleshooting

**"Email already in use" when creating a user**
Email must be unique. Check existing users with `GET /api/users`.

**"Cannot delete your own account"**
Intentional safeguard. Log in as a different admin to delete the account.

**"Current password is incorrect" when changing password**
The submitted current password does not match. Admins can bypass this by calling `POST /api/users/:id/change-password` for another user without providing `currentPassword`.

**"Registration disabled" on `POST /api/auth/register`**
At least one user exists. Use `POST /api/users` with an admin token to create additional accounts.

**API token returns 401 after rotation**
Any system using the old token value will fail. Update the token in all dependent systems before revoking the old one. Consider creating the replacement token first, updating integrations, then deleting the old token.

**User not showing as "Online" in admin panel**
`lastActiveAt` is only updated on JWT requests, not API token requests. Users authenticating exclusively via API tokens (e.g., service accounts) will not appear online.

**Admin cannot change their own role in the UI**
The role dropdown is intentionally disabled when editing your own account. Ask another admin to make the change.

---

## Related

- [Environments](environments.md) -- per-environment `allowSecretReveal` permission
- [API Reference](../reference/api.md) -- full endpoint documentation
- [Real-Time Events](../reference/events.md) -- SSE authentication with API tokens
- [System Settings](../reference/system-settings.md) -- `activeUserWindowMin` and other defaults
