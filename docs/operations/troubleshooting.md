# Troubleshooting

A practical guide to diagnosing and fixing common BRIDGEPORT issues, with a quick-reference table and step-by-step debugging instructions.

---

## Table of Contents

- [General Debugging](#general-debugging)
- [Quick Troubleshooting Table](#quick-troubleshooting-table)
- [Container Won't Start](#container-wont-start)
- [Authentication Issues](#authentication-issues)
- [SSH Connection Failures](#ssh-connection-failures)
- [Docker Socket Issues](#docker-socket-issues)
- [Agent Not Reporting](#agent-not-reporting)
- [Deployment Failures](#deployment-failures)
- [Backup Failures](#backup-failures)
- [Notification Delivery Issues](#notification-delivery-issues)
- [Performance Issues](#performance-issues)
- [Database Migration Issues](#database-migration-issues)
- [Lost MASTER_KEY](#lost-master_key)

---

## General Debugging

### Reading BRIDGEPORT Logs

BRIDGEPORT logs structured JSON in production and pretty-printed output in development. Start here for any issue:

```bash
# View recent logs
docker logs bridgeport --tail 100

# Follow logs in real time
docker logs bridgeport -f

# Search for errors
docker logs bridgeport 2>&1 | grep -i error
```

### Health Endpoint

The `/health` endpoint gives you a quick status check:

```bash
curl -s http://localhost:3000/health | jq .
```

```json
{
  "status": "ok",
  "timestamp": "2026-02-25T12:00:00.000Z",
  "version": "1.0.0",
  "bundledAgentVersion": "20260220-abc1234",
  "cliVersion": "20260218-def5678"
}
```

If this endpoint does not respond, BRIDGEPORT is not running or not reachable.

### Common Log Messages

| Log Message | Meaning |
|-------------|---------|
| `=== BRIDGEPORT Startup ===` | Entrypoint script began |
| `Applying migrations...` | Prisma is running pending database migrations |
| `Prisma Migrate applied all migrations.` | Migrations completed successfully |
| `=== Starting BRIDGEPORT ===` | Application is about to start |
| `BRIDGEPORT running at http://0.0.0.0:3000` | Startup completed, ready to accept requests |
| `[Scheduler] Starting with intervals:` | Background scheduler started |
| `[Scheduler] Health check failed for server X` | SSH or URL health check failed for a server |
| `[Scheduler] Auto-deploying container image` | Auto-update triggered a deployment |
| `Crypto not initialized` | `MASTER_KEY` is missing or invalid |

---

## Quick Troubleshooting Table

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Container exits on startup | Missing `MASTER_KEY` or `JWT_SECRET` | Check `.env` has all required variables |
| Container exits with migration error | Bad migration SQL in new release | Restore backup, pin previous version, report bug |
| Can't log in (no users) | `ADMIN_EMAIL`/`ADMIN_PASSWORD` not set on first boot | Set env vars, delete database, restart |
| Can't connect to server | SSH key issue or firewall | Check key in Settings > SSH, test from Monitoring > Agents |
| Container not found during discovery | Service not running or name changed | Check `docker ps` on the server, run manual discovery |
| Health check always fails | Wrong health endpoint URL | Verify the URL in service settings, test with `curl` |
| Agent not reporting metrics | Token mismatch or network issue | Regenerate token, verify `BRIDGEPORT_SERVER` URL |
| Notifications not being sent | SMTP/Slack not configured | Check Admin > Notifications for channel configuration |
| Deploy fails with "image not found" | Registry credentials expired or wrong | Re-enter credentials in Registries page |
| Backup fails with timeout | Large database exceeds default timeout | Increase `pgDumpTimeoutMs` in System Settings |
| UI shows old version | Browser cache | Hard refresh (`Ctrl+Shift+R` or `Cmd+Shift+R`) |
| Metrics page is slow | Large metrics history | Reduce retention in environment monitoring settings |

---

## Container Won't Start

### Missing Environment Variables

BRIDGEPORT requires three environment variables to start. If any are missing, it exits immediately:

```bash
# Check your .env file has these
DATABASE_URL=file:/data/bridgeport.db
MASTER_KEY=<your-32-byte-base64-key>
JWT_SECRET=<your-32-byte-base64-key>
```

Generate new keys if needed:

```bash
openssl rand -base64 32  # For MASTER_KEY
openssl rand -base64 32  # For JWT_SECRET (use a different value)
```

### Database File Permissions

If the data directory is not writable, BRIDGEPORT cannot create or modify the database:

```bash
# Check ownership (should be writable by UID 1000, the node user)
ls -la ./data/

# Fix permissions if needed
sudo chown -R 1000:1000 ./data/
```

### Migration Errors

If the logs show a Prisma migration error during startup:

1. **Check the exact error** in `docker logs bridgeport`
2. This usually indicates a bug in a new release's migration
3. **Restore your pre-upgrade backup** and pin the previous version
4. See [Database Migration Issues](#database-migration-issues) for details

---

## Authentication Issues

### No Admin User on First Boot

The initial admin user is only created when:
1. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set in the environment
2. No users exist in the database yet

If you started BRIDGEPORT without these variables, the database was created with no users.

**Fix**: Stop BRIDGEPORT, delete the database, set the variables, and restart:

```bash
docker compose stop
rm ./data/bridgeport.db
# Make sure ADMIN_EMAIL and ADMIN_PASSWORD are in .env
docker compose up -d
```

### Forgot Admin Password

If an admin account exists but you forgot the password:

- Another admin can reset it from the **Admin > Users** page
- If no other admin exists, you will need to reset the database or update the password hash directly in the SQLite database

### JWT Token Expired

JWT tokens expire after 7 days. The UI handles token refresh automatically. If using API tokens for scripts, create a long-lived API token from the **My Account** modal instead.

---

## SSH Connection Failures

### Diagnosis Steps

1. **Verify the SSH key** is uploaded in **Settings > SSH** for the correct environment

2. **Check the SSH user** in **Settings > General** matches the authorized user on the server

3. **Test connectivity** from **Monitoring > Agents** using the SSH test feature

4. **Try manual SSH** from the BRIDGEPORT container:
   ```bash
   docker exec -it bridgeport sh
   ssh -i /tmp/test-key user@server-ip -o StrictHostKeyChecking=no
   ```

### Common Causes

| Issue | Fix |
|-------|-----|
| "Connection refused" | Ensure sshd is running on port 22 and firewall allows connections from BRIDGEPORT's network |
| "Permission denied" | Verify the public key is in `~/.ssh/authorized_keys` on the target server |
| "Host key verification failed" | BRIDGEPORT uses `StrictHostKeyChecking=no` by default; this error is rare but check SSH config |
| "Key format not supported" | BRIDGEPORT expects OpenSSH format keys. Convert with `ssh-keygen -p -m PEM -f key.pem` |
| "Timeout" | Network routing issue. Verify the server hostname/IP is reachable from the Docker network |

---

## Docker Socket Issues

If using socket mode for managing containers on the host:

### Socket Not Mounted

Verify the Docker socket is mounted in `docker-compose.yml`:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

### Permission Denied on Socket

Find the Docker socket group ID and add it to the container:

```bash
stat -c '%g' /var/run/docker.sock
# Output: 999 (or similar)
```

Add to your compose file:

```yaml
services:
  bridgeport:
    group_add:
      - "999"  # Use the actual group ID from stat
```

---

## Agent Not Reporting

### Check Agent Status

On the target server:

```bash
# Check if the agent service is running
systemctl status bridgeport-agent

# View agent logs
journalctl -u bridgeport-agent -f --no-pager -n 50
```

### Verify Connectivity

From the agent server, check that BRIDGEPORT is reachable:

```bash
curl http://your-bridgeport-host:3000/health
```

If using an internal IP, ensure `agentCallbackUrl` is set correctly in **Admin > System Settings**.

### Token Mismatch

If the agent logs show authentication errors:

1. Go to the server's detail page in BRIDGEPORT
2. Regenerate the agent token
3. Redeploy the agent (this updates the token automatically)

### Docker Access

The agent needs access to the Docker socket to collect container metrics:

```bash
ls -la /var/run/docker.sock
# Add the agent user to the docker group if needed:
sudo usermod -aG docker $(whoami)
```

---

## Deployment Failures

### Image Not Found

If a deploy fails with "image not found" or "pull access denied":

1. Verify the image name and tag exist in your registry
2. Check that registry credentials are valid in the **Registries** page
3. Test manually from the target server: `docker pull your-image:tag`

### Health Check Fails After Deploy

If deployment orchestration fails at the health check step:

1. Check the deployment plan detail page for the specific error
2. Verify the service's `healthCheckUrl` returns a 2xx status
3. Increase `healthWaitMs` if the service takes time to start
4. Increase `healthRetries` for services with slow startup

### Rollback Was Triggered

If auto-rollback activated during an orchestrated deployment:

1. Check the deployment plan detail page -- it shows which step failed
2. The `error` and `logs` fields on the failed step contain the root cause
3. All previously deployed services were automatically rolled back to their previous tags

---

## Backup Failures

### PostgreSQL Backup Fails

| Symptom | Fix |
|---------|-----|
| "Connection refused" | Verify database host/port are reachable from BRIDGEPORT's server |
| "Authentication failed" | Re-enter database credentials on the database detail page |
| "pg_dump: command not found" | The BRIDGEPORT Docker image includes `postgresql16-client`. If using a different version, ensure compatibility |
| Timeout | Increase `pgDumpTimeoutMs` in **Admin > System Settings** (default: 300000ms / 5 minutes) |

### Spaces Upload Fails

1. Verify storage credentials in **Admin > Storage**
2. Ensure the target bucket exists
3. Check that the access key has write permissions to the bucket

### Scheduled Backups Not Running

1. Confirm the scheduler is enabled: `SCHEDULER_ENABLED=true` (default)
2. Check the backup schedule is enabled on the database detail page
3. Verify `nextRunAt` is set -- if it shows `null`, the schedule may need to be re-saved

---

## Notification Delivery Issues

### In-App Notifications Not Appearing

1. Check that the notification type is enabled in **Admin > Notifications**
2. Verify the user's notification preferences include `in_app` for that type
3. Check the notification bell icon -- you may need to refresh

### Email Notifications Not Sending

1. Verify SMTP is configured in **Admin > Notifications > SMTP**
2. Test the SMTP connection from the admin page
3. Check BRIDGEPORT logs for SMTP errors: `docker logs bridgeport 2>&1 | grep -i smtp`
4. Verify the user has `email` enabled in their notification preferences

### Slack Notifications Not Sending

1. Verify Slack channels are configured in **Admin > Notifications > Slack**
2. Check that notification types are routed to the correct Slack channel
3. Test the webhook URL from the admin page

---

## Performance Issues

### High CPU or Memory Usage

1. **Reduce metrics collection frequency**: Increase intervals in **Settings > Monitoring** (e.g., change from 60s to 300s)
2. **Reduce retention**: Lower `metricsRetentionDays` to reduce database size
3. **Check database size**:
   ```bash
   ls -lh ./data/bridgeport.db
   ```
4. **Vacuum the database** (requires stopping BRIDGEPORT):
   ```bash
   docker compose stop
   sqlite3 ./data/bridgeport.db "VACUUM;"
   docker compose start
   ```

### Slow Page Loads

- **Monitoring pages**: Reduce the selected time range or the number of monitored resources
- **Health check logs**: Reduce `healthLogRetentionDays` in environment settings
- **Audit logs**: Reduce `auditLogRetentionDays` in System Settings

---

## Database Migration Issues

BRIDGEPORT runs `prisma migrate deploy` automatically on every startup. If a migration fails:

1. **Check the error message** in `docker logs bridgeport`
2. **Do not modify the database manually** -- this breaks Prisma's migration state
3. **Restore your pre-upgrade backup** if the migration corrupted data
4. **Pin the previous version** until the issue is fixed upstream

For legacy databases (created before migration tracking was added), BRIDGEPORT automatically creates a migration baseline on first startup. This is a one-time operation and should not require intervention.

---

## Lost MASTER_KEY

If you lose your `MASTER_KEY`, all encrypted data becomes irrecoverable:

- All secrets
- SSH keys for every environment
- Registry credentials
- SMTP passwords
- Slack webhook URLs
- Spaces secret keys

**What still works**: Servers, services, environments, config files, users, metrics, audit logs, deployment history, and all other unencrypted data.

**Recovery steps**:

1. Generate a new key: `openssl rand -base64 32`
2. Update `.env` with the new `MASTER_KEY`
3. Restart BRIDGEPORT
4. Re-create all encrypted resources (SSH keys, secrets, registry credentials, SMTP config)

See [Backup & Restore > Lost MASTER_KEY](backup-restore.md#lost-master_key) for detailed steps.

---

## Related Documentation

- [Backup & Restore](backup-restore.md) -- recovery procedures
- [Security & Hardening](security.md) -- securing your deployment
- [Upgrades](upgrades.md) -- upgrade-specific issues
- [Configuration Reference](../configuration.md) -- environment variable reference
