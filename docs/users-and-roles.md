# Users & Roles

BridgePort uses role-based access control (RBAC) with three roles to manage who can do what.

## Roles

| Role | Description |
|------|-------------|
| **Admin** | Full access to everything, including user management, environment creation, and settings |
| **Operator** | Can deploy, restart, manage secrets, config files, and databases. Cannot manage users or create environments |
| **Viewer** | Read-only access to all resources. Cannot modify anything |

### Permission Matrix

| Action | Admin | Operator | Viewer |
|--------|-------|----------|--------|
| View servers, services, metrics | Yes | Yes | Yes |
| View secrets (list, not values) | Yes | Yes | Yes |
| Reveal secret values | Yes | Yes* | Yes* |
| Deploy services | Yes | Yes | No |
| Restart services | Yes | Yes | No |
| Create/edit/delete secrets | Yes | Yes | No |
| Create/edit/delete config files | Yes | Yes | No |
| Sync config files to servers | Yes | Yes | No |
| Create/edit/delete databases | Yes | Yes | No |
| Trigger/delete backups | Yes | Yes | No |
| Create environments | Yes | No | No |
| Manage users | Yes | No | No |
| Edit environment settings | Yes | No | No |
| Manage service types | Yes | No | No |
| Manage system settings | Yes | No | No |

\* Subject to environment-level and secret-level reveal controls.

## Managing Users

### Creating a User (Admin)

1. Go to **Users** in the sidebar (admin only)
2. Click **Add User**
3. Enter name, email, password, and role
4. The user can now log in

### Editing a User

Admins can edit any user's name, email, and role. Users cannot change their own role.

### Deleting a User

Admins can delete any user except themselves.

### Initial Admin User

The first admin user is created automatically on first boot using the `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables. This only happens when the database has no existing users.

## Self-Service Account

All users (regardless of role) can manage their own account:

1. Click the **user icon** in the sidebar
2. In the **My Account** modal, you can:
   - Update your name and email
   - Change your password (requires current password)

## Active Users

The Users page shows which users are currently active (online in the last 15 minutes). This is tracked via the `lastActiveAt` timestamp updated on each authenticated API request.

## Authentication

BridgePort uses JWT (JSON Web Token) authentication:

1. User logs in with email and password
2. Server returns a JWT token
3. Token is included in all subsequent API requests
4. Passwords are hashed with bcrypt

### Session Management

- Tokens are stored in the browser's local storage
- There is no explicit session timeout in the token itself
- The active user window (configurable in System Settings) determines the "online" threshold
