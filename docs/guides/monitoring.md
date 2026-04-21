# Monitoring Quick Start

BRIDGEPORT monitors your servers, containers, and databases through three complementary systems -- pick the one that fits your infrastructure and follow the link to its deep-dive guide.

## Which Monitoring Do You Need?

Use this decision tree to find the right guide:

```mermaid
flowchart TD
    START([What do you want to monitor?]) --> Q1{Server-level metrics?<br/>CPU, memory, disk, load}
    START --> Q2{Container metrics?<br/>CPU, memory, network I/O}
    START --> Q3{Database metrics?<br/>Size, queries, performance}

    Q1 -->|Yes| Q1A{Is BRIDGEPORT agent<br/>deployed on the server?}
    Q1A -->|No - SSH polling| SERVERS["<b>Server Monitoring</b><br/>SSH mode collects metrics<br/>every 5 minutes"]
    Q1A -->|Yes - Agent push| SERVERS_AGENT["<b>Server Monitoring</b><br/>Agent pushes real-time<br/>metrics + processes"]

    Q2 -->|Yes| SERVICES["<b>Service Monitoring</b><br/>Docker stats via<br/>SSH or agent"]

    Q3 -->|Yes| DATABASES["<b>Database Monitoring</b><br/>Plugin-driven queries<br/>via SQL or SSH"]

    SERVERS --> LINK_S[monitoring-servers.md]
    SERVERS_AGENT --> LINK_S
    SERVICES --> LINK_SVC[monitoring-services.md]
    DATABASES --> LINK_DB[monitoring-databases.md]

    style LINK_S fill:#1e40af,color:#fff
    style LINK_SVC fill:#1e40af,color:#fff
    style LINK_DB fill:#1e40af,color:#fff
```

## Quick Setup by Mode

### SSH Polling (simplest)

No agent required. BRIDGEPORT connects over SSH to collect server metrics.

1. Go to **Servers** and select a server.
2. In the **Monitoring** card, set **Metrics Mode** to `ssh`.
3. Metrics appear within one collection cycle (default: 5 minutes).

View charts at **Monitoring > Servers**. See [Server Monitoring](monitoring-servers.md) for the full guide.

### Agent Push (recommended for production)

The agent runs on each server and pushes metrics in real time, including container stats and top processes.

1. Go to **Servers** and select a server.
2. Set **Metrics Mode** to `agent`.
3. BRIDGEPORT auto-deploys the agent via SSH.
4. Within 30 seconds you should see the agent status change to `active`.

View charts at **Monitoring > Servers** and **Monitoring > Services**. See [Server Monitoring](monitoring-servers.md) and [Service Monitoring](monitoring-services.md).

### Database Monitoring

Plugin-driven queries collect database-specific metrics (size, row counts, slow queries, etc.).

1. Go to **Databases** and select a database.
2. Toggle **Enable Monitoring** on.
3. Click **Test Connection** to verify connectivity.
4. Metrics appear after the first collection interval (default: 60 seconds).

View charts at **Monitoring > Databases**. See [Database Monitoring](monitoring-databases.md).

## Monitoring Overview Hub

The **Monitoring > Overview** page (`/monitoring`) shows a summary of all three systems at a glance:

- Total and healthy servers, services, and databases
- Active alerts count
- Quick links to each sub-page

The UI auto-refreshes every 30 seconds.

## Quick Comparison

| Capability | SSH Polling | Agent | Database Monitoring |
|---|---|---|---|
| Server metrics (CPU, memory, disk) | Yes | Yes | -- |
| Container metrics (CPU, memory, network) | -- | Yes | -- |
| Top processes | -- | Yes | -- |
| Container discovery | Yes | Yes | -- |
| TCP/cert checks | -- | Yes | -- |
| Database-specific metrics | -- | -- | Yes |
| Collection method | Pull (SSH) | Push (HTTP) | Pull (SQL/SSH/Redis) |
| Default interval | 5 min | ~15 sec | 60 sec |

## Next Steps

- [Server Monitoring](monitoring-servers.md) -- CPU, memory, disk, load, swap, TCP connections, file descriptors
- [Service Monitoring](monitoring-services.md) -- Container CPU, memory, network I/O, block I/O
- [Database Monitoring](monitoring-databases.md) -- Plugin-driven queries for PostgreSQL, MySQL, SQLite, Redis
- [Health Checks](health-checks.md) -- Container health, URL checks, TCP port checks, certificate expiry
- [Notifications](notifications.md) -- Get alerted when things go wrong
- [Configuration Reference](../configuration.md) -- Scheduler intervals and retention settings
