# Troubleshooting

Common issues and their solutions when running BridgePort.

## Container Won't Start

### Symptoms
- `docker compose up` exits immediately
- Logs show migration errors

### Solutions

**Check the logs**:
```bash
docker logs bridgeport
```

**Migration errors**: If the startup script fails during migration, the issue is in the migration SQL. Check the Prisma migration files and fix any issues, then rebuild and redeploy.

**Missing environment variables**: Ensure `DATABASE_URL`, `MASTER_KEY`, and `JWT_SECRET` are set in your `.env` file.

**Database file permissions**: Ensure the data directory is writable:
```bash
chmod 777 /opt/bridgeport/data
```

## Can't Log In

### First Boot — No Admin User Created

The initial admin user is only created when:
1. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set in the environment
2. No users exist in the database

If you changed these values after the first boot, they won't take effect. Reset by deleting the database and starting fresh, or use the API to create a new user.

### Forgot Password

Admins can reset any user's password from the Users page. If you've lost the admin password, you'll need to reset the database or use direct database access to update the password hash.

## SSH Connection Failures

### Symptoms
- Health checks fail with "Connection refused" or "Timeout"
- File sync fails
- Container discovery fails

### Solutions

**Verify SSH key**: Ensure the correct SSH private key is uploaded in environment settings.

**Check SSH user**: Verify the SSH user (Settings > General) matches the authorized user on the server.

**Test connectivity**: Go to Monitoring > Agents and use the SSH test feature to diagnose connection issues.

**Firewall rules**: Ensure port 22 is open from BridgePort's network to the target server.

**Key format**: BridgePort expects OpenSSH format private keys. If you have a PEM or PuTTY format key, convert it:
```bash
ssh-keygen -p -m PEM -f key.pem  # Convert PEM to OpenSSH
```

## Docker Socket Issues

### Symptoms
- "localhost" server not auto-created
- Socket mode operations fail

### Solutions

**Check socket mount**: Verify the Docker socket is mounted in your `docker-compose.yml`:
```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

**Check permissions**: Find and add the correct Docker group ID:
```bash
stat -c '%g' /var/run/docker.sock
```

Add it to your compose file:
```yaml
group_add:
  - "999"  # Replace with your actual group ID
```

## Agent Not Reporting Metrics

### Symptoms
- Server shows "No metrics" despite agent running
- Agent logs show connection errors

### Solutions

**Check agent logs**:
```bash
journalctl -u bridgeport-agent -f
```

**Verify token**: Ensure the agent token matches the one shown in BridgePort's server settings.

**Check URL**: Ensure `BRIDGEPORT_SERVER` is reachable from the agent server:
```bash
curl http://your-bridgeport:3000/health
```

**Metrics mode**: Verify the server's metrics mode is set to "Agent" in BridgePort.

**Docker access**: The agent needs access to the Docker socket to collect container metrics:
```bash
ls -la /var/run/docker.sock
# If needed: usermod -aG docker $(whoami)
```

## Backups Failing

### Symptoms
- Manual backup shows "failed" status
- Scheduled backups not running

### Solutions

**PostgreSQL connection**: Verify the database credentials and that the host is reachable from BridgePort's server.

**pg_dump not found**: For local backups, `pg_dump` must be available on the server where BridgePort is running. The Docker image includes PostgreSQL client tools.

**Timeout**: For large databases, increase the pg_dump timeout in the database settings or System Settings.

**Spaces uploads failing**: Verify your Spaces credentials at Settings > Spaces and ensure the bucket exists.

**Check scheduler**: Ensure the scheduler is enabled (`SCHEDULER_ENABLED=true`) and the backup check interval is set.

## Config File Sync Failures

### Symptoms
- Sync shows "failed" for one or more files
- Missing secrets error

### Solutions

**Missing secrets**: The error message lists which secret keys are referenced but not found. Create the missing secrets before syncing.

**Permission denied**: Ensure the SSH user has write access to the target directory on the server.

**Directory doesn't exist**: BridgePort automatically creates parent directories, but the SSH user must have permission to do so.

## Performance Issues

### High CPU / Memory Usage

**Reduce metrics collection frequency**: Increase the metrics collection interval in environment settings.

**Reduce retention**: Lower the metrics retention period to reduce database size.

**Check database size**: The SQLite database can grow large with many metrics. Check its size:
```bash
ls -lh /opt/bridgeport/data/bridgeport.db
```

**Vacuum the database** (requires stopping BridgePort):
```bash
docker compose stop
sqlite3 /opt/bridgeport/data/bridgeport.db "VACUUM;"
docker compose start
```

### Slow Page Loads

**Metrics data**: If monitoring pages are slow, reduce the time range or the number of monitored resources.

**Health check logs**: Old logs accumulate over time. Reduce the health log retention period.

## Lost MASTER_KEY

If you lose your `MASTER_KEY`, encrypted data cannot be recovered. This includes:
- All secrets
- SSH keys
- Registry credentials

You will need to:
1. Re-create all secrets
2. Re-upload SSH keys for each environment
3. Re-enter registry credentials

The rest of the data (servers, services, config files, etc.) is not encrypted and will still be accessible.

## Database Migration Issues

BridgePort automatically runs Prisma migrations on startup. If a migration fails:

1. Check the logs for the specific error
2. The issue is in the migration SQL — it may need manual intervention
3. Fix the issue, rebuild the Docker image, and restart

For legacy databases (created before migration tracking), BridgePort automatically baselines them on first startup.
