# User Management & RBAC

BridgePort uses a three-tier role system to control who can view, operate, and administer the platform — with every user action logged to the audit trail.

## Table of Contents

1. [Quick Start: Creating Your First User](#quick-start-creating-your-first-user)
2. [Roles & Permissions](#roles--permissions)
3. [Managing Users](#managing-users)
4. [Self-Service Account](#self-service-account)
5. [API Tokens](#api-tokens)
6. [Initial Admin Setup](#initial-admin-setup)
7. [Active User Tracking](#active-user-tracking)
8. [Troubleshooting](#troubleshooting)
9. [Related Docs](#related-docs)

---

## Quick Start: Creating Your First User

After the initial admin account exists (see [Initial Admin Setup](#initial-admin-setup)), create additional users from the admin panel:

1. Navigate to **Admin → Users** (`/admin/users`).
2. Click **Add User**.
3. Fill in the form:
   - **Email** — must be unique across all users
   - **Password** — minimum 8 characters
   - **Name** — optional display name
   - **Role** — defaults to `viewer`; see [Roles & Permissions](#roles--permissions)
4. Click **Create**.

The new user receives a welcome notification (in-app and email, per their notification preferences) and can log in immediately.

> [!NOTE]
> Email addresses cannot be changed after account creation. If a user needs a different email, delete the old account and create a new one.

---

## Roles & Permissions

BridgePort has three roles in strict hierarchy: `admin` > `operator` > `viewer`. A user inherits all permissions of lower roles.

### Permission Matrix

| Action | Admin | Operator | Viewer |
|--------|:-----:|:--------:|:------:|
| View all resources | Yes | Yes | Yes |
| Reveal secret values | Yes | Yes* | Yes* |
| Deploy services | Yes | Yes | No |
| Restart/stop services | Yes | Yes | No |
| Manage secrets | Yes | Yes | No |
| Manage config files & sync | Yes | Yes | No |
| Manage databases & backups | Yes | Yes | No |
| Create/delete environments | Yes | No | No |
| Manage users | Yes | No | No |
| Edit environment settings | Yes | No | No |
| Manage service types | Yes | No | No |
| System settings | Yes | No | No |

\* Secret reveal is subject to per-environment and per-secret controls configured by admins.

### Role Descriptions

**`viewer`**
Read-only access to all resources in every environment. Suitable for stakeholders, on-call engineers who need visibility, or external auditors. Viewers can browse deployments, health checks, logs, and metrics but cannot change anything.

**`operator`**
Everything a viewer can do, plus the ability to take operational actions: deploying services, managing secrets, syncing config files, triggering backups, and running health checks. Suitable for engineers who operate the platform day-to-day.

**`admin`**
Full access. Admins manage users, environments, system settings, and all resources. There is no sudo or separate super-admin concept — admin is the top tier.

> [!WARNING]
> An admin cannot change their own role. This prevents accidental self-demotion. Another admin must make the change. The same constraint is enforced in the UI: the role dropdown is disabled when editing your own account.

---

## Managing Users

All user management is under **Admin → Users** (`/admin/users`). These actions require the `admin` role.

### Creating a User

**API:**
```http
POST /api/users
Authorization: Bearer <token>
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "securepassword",
  "name": "Alice",
  "role": "operator"
}
```

**Response (201):**
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

Password validation: minimum 8 characters. If the email is already in use, the server returns `409 Conflict`.

### Listing Users

**API:**
```http
GET /api/users
Authorization: Bearer <token>
```

Returns all users ordered by creation date (newest first). Each record includes `id`, `email`, `name`, `role`, `lastActiveAt`, `createdAt`, and `updatedAt`. Password hashes are never returned.

### Editing a User

Admins can update a user's `name` and `role`. Email is immutable.

**API:**
```http
PATCH /api/users/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Alice Smith",
  "role": "admin"
}
```

When a role change is saved, the affected user receives an in-app and email notification: _"Your role has been changed from operator to admin."_

> [!NOTE]
> Non-admin users can call `PATCH /api/users/:id` for their own account to update their `name`. Any attempt to include a `role` field is rejected with `403 Forbidden`.

### Resetting a User's Password (Admin)

Admins can reset any user's password without knowing the current one:

**API:**
```http
POST /api/users/:id/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "newPassword": "newSecurePassword"
}
```

The affected user receives a notification: _"Your password was changed by an administrator."_

### Deleting a User

**API:**
```http
DELETE /api/users/:id
Authorization: Bearer <token>
```

Returns `400 Bad Request` if you attempt to delete your own account. All related records (deployments, audit logs, API tokens) are cascade-deleted with the user.

> [!WARNING]
> Deletion is permanent. There is no deactivation or suspension mechanism — if you need to revoke access without losing audit history, consider rotating the user's password instead and revoking all their API tokens.

---

## Self-Service Account

Every user, regardless of role, can manage their own profile without admin involvement.

### Accessing My Account

Click the **user icon** at the bottom of the left sidebar. The **My Account** modal opens with two tabs:

- **Profile** — update your display name; email and role are read-only here
- **Change Password** — update your own password

### Updating Your Name

In the Profile tab, edit the Name field and click **Save Changes**. The change takes effect immediately and is reflected in the sidebar.

### Changing Your Password

In the Change Password tab:

1. Enter your **Current Password**.
2. Enter and confirm your **New Password** (minimum 8 characters).
3. Click **Change Password**.

You receive a notification confirming the change. If the current password is incorrect, the server returns `401 Unauthorized`.

**API equivalent:**
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
> When a non-admin user changes their own password, `currentPassword` is required. Admins resetting another user's password do not need to provide `currentPassword`.

---

## API Tokens

API tokens let scripts, CI/CD pipelines, and external tools authenticate as a specific user without exposing that user's login password. Tokens carry the same role permissions as their owner.

### Creating a Token

**UI:** Click the user icon in the sidebar → My Account → (token management is accessible via the API only at this time).

**API:**
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
> The full token value is returned **only once** at creation time. BridgePort stores only a hash of the token. Copy it immediately and store it in your secrets manager — it cannot be recovered later. If lost, delete the token and create a new one.

`expiresInDays` is optional. Omitting it creates a non-expiring token.

### Listing Your Tokens

```http
GET /api/auth/tokens
Authorization: Bearer <token>
```

Returns all tokens belonging to the authenticated user. `tokenHash` is never returned. Each record includes `id`, `name`, `lastUsedAt`, `expiresAt`, and `createdAt`.

### Revoking a Token

```http
DELETE /api/auth/tokens/:tokenId
Authorization: Bearer <token>
```

You can only delete your own tokens. Returns `404 Not Found` if the token does not exist or belongs to another user.

### Using a Token

**HTTP header (most requests):**
```http
Authorization: Bearer bp_abc123...
```

**Query parameter (SSE connections):**
```
GET /api/sse/events?token=bp_abc123...
```

The authentication layer tries an API token lookup first, then falls back to JWT verification. `lastUsedAt` is updated on each successful use.

### Token Use Cases

| Use Case | Notes |
|----------|-------|
| CI/CD pipeline | Create a dedicated token per pipeline with `operator` role |
| Monitoring scripts | Use a `viewer`-role token for read-only metric polling |
| SSE event streams | Pass via query param `token=` since SSE clients often cannot set headers |
| Infrastructure-as-code | Store in a secrets manager; rotate on a schedule using `expiresInDays` |

> [!TIP]
> Name tokens descriptively (e.g., `"github-actions-staging"`, `"grafana-readonly"`) so they are easy to identify and revoke when no longer needed. The `lastUsedAt` field helps identify stale tokens that can be cleaned up.

---

## Initial Admin Setup

On first boot, if no users exist in the database, BridgePort creates an admin account using two environment variables:

```bash
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password
```

The bootstrap logic in `src/services/auth.ts` runs `bootstrapAdminUser()` at startup. It checks `prisma.user.count()` and only proceeds if the count is zero — making it safe to leave these variables set in production without risk of duplicate account creation.

If neither variable is set, the bootstrap step is skipped silently. In that case, use the first-user registration endpoint:

```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "securepassword",
  "name": "Admin"
}
```

This endpoint creates the user with the `admin` role and returns a JWT. It returns `403 Forbidden` if any user already exists, effectively disabling open registration once the instance is bootstrapped.

> [!NOTE]
> `ADMIN_PASSWORD` must be at least 8 characters. The `ADMIN_EMAIL` must be a valid email address. If either value fails validation, the server exits at startup with a configuration error.

---

## Active User Tracking

BridgePort tracks when users are actively using the application. On every authenticated HTTP request (JWT-based, not API token), the `lastActiveAt` field on the `User` record is updated in the background (fire-and-forget, does not add latency).

### Viewing Active Users

In **Admin → Users**, the page header shows an "Active Users" summary panel listing everyone active within the configured window. Individual user cards show a pulsing green "Online" badge for currently active users.

**API:**
```http
GET /api/users/active
Authorization: Bearer <token>
```

Returns users whose `lastActiveAt` is within the active window.

### Configuring the Active Window

The window duration is controlled by `activeUserWindowMin` in System Settings, defaulting to **15 minutes**. Change it at **Admin → System** or via:

```http
PATCH /api/system-settings
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "activeUserWindowMin": 30
}
```

> [!NOTE]
> API token requests do not update `lastActiveAt`. Active user tracking reflects interactive browser sessions only.

---

## Troubleshooting

**"Email already in use" when creating a user**
The email must be unique. Check existing users with `GET /api/users`. If the email belongs to a deleted user that was not fully purged, check the database directly.

**"Cannot delete your own account"**
This is an intentional safeguard. Log in as a different admin to delete the account, or demote the account to `viewer` if you only want to restrict access.

**"Current password is incorrect" when changing password**
The current password submitted does not match. Admins can bypass this check by calling `POST /api/users/:id/change-password` without providing `currentPassword`.

**"Registration disabled" on `POST /api/auth/register`**
At least one user exists. Use `POST /api/users` with an existing admin token to create additional accounts.

**API token returns 401 after rotation**
After deleting a token, any system still using the old value will receive `401 Unauthorized`. Update the token value in all dependent systems before revoking the old one.

**User is not showing as "Online" in the admin panel**
The active window check is based on `lastActiveAt`, which is only updated on JWT-authenticated requests — not API token requests. If the user authenticates exclusively via API token (e.g., a service account), they will not appear as online.

**Admin cannot change their own role in the UI**
The role dropdown is intentionally disabled when editing your own account. Ask another admin to make the change.

---

## Related Docs

- [Audit Logs](../audit.md) — every user management action is recorded
- [Notification Settings](../notifications.md) — configure which channels receive user event notifications
- [Environment Settings](../environments.md) — per-environment secret reveal permissions
- [System Settings](../system-settings.md) — `activeUserWindowMin` and other operational defaults
