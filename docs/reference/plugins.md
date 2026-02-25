# Plugin Reference

BridgePort uses a JSON-based plugin system to define service types (Django, Node.js, etc.) and database types (PostgreSQL, MySQL, etc.) with their commands, connection fields, and monitoring queries. This page covers the plugin format, directory structure, lifecycle, and how to create your own plugins.

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Service Type Plugins](#service-type-plugins)
  - [JSON Schema](#service-type-json-schema)
  - [Field Reference](#service-type-field-reference)
  - [Example: Django](#example-django)
  - [Creating a Custom Service Type](#creating-a-custom-service-type)
- [Database Type Plugins](#database-type-plugins)
  - [JSON Schema](#database-type-json-schema)
  - [Field Reference](#database-type-field-reference)
  - [Connection Fields](#connection-fields)
  - [Commands and Placeholders](#commands-and-placeholders)
  - [Monitoring Queries](#monitoring-queries)
  - [Example: PostgreSQL](#example-postgresql)
  - [Creating a Custom Database Type](#creating-a-custom-database-type)
- [Plugin Lifecycle](#plugin-lifecycle)
  - [Startup Sync](#startup-sync)
  - [Smart Merge Behavior](#smart-merge-behavior)
  - [The `isCustomized` Flag](#the-iscustomized-flag)
  - [Resetting to Defaults](#resetting-to-defaults)
  - [Exporting as JSON](#exporting-as-json)
- [Built-In Plugins](#built-in-plugins)
- [Related Docs](#related-docs)

---

## Overview

Plugins are JSON files in the `plugins/` directory (configurable via the `PLUGINS_DIR` environment variable, default: `./plugins`). On every server startup, BridgePort's `syncPlugins()` function reads these files and synchronizes them to the database.

Plugins define two things:

1. **Service types** -- Predefined shell commands for containers (e.g., `python manage.py shell` for Django)
2. **Database types** -- Connection field definitions, backup/restore command templates, shell commands, and monitoring queries

Admins can also create and edit types through the UI. The plugin system tracks whether a type has been customized via the UI, and uses smart merge logic to avoid overwriting manual edits.

---

## Directory Structure

```
plugins/
├── schemas/
│   ├── service-type.schema.json     # JSON Schema for validation
│   └── database-type.schema.json    # JSON Schema for validation
├── service-types/
│   ├── django.json
│   ├── nodejs.json
│   ├── generic.json
│   └── your-custom-type.json        # Add your own here
└── database-types/
    ├── postgres.json
    ├── mysql.json
    ├── sqlite.json
    ├── mongodb.json
    ├── redis.json
    └── your-custom-db.json          # Add your own here
```

File names must match the `name` field inside the JSON (e.g., `django.json` contains `"name": "django"`).

---

## Service Type Plugins

Service types define predefined commands that can be run inside containers via the UI or the [`bridgeport run`](cli.md#run) CLI command.

### Service Type JSON Schema

```json
{
  "name": "lowercase-with-hyphens",
  "displayName": "Human Readable Name",
  "commands": [
    {
      "name": "command-slug",
      "displayName": "Command Label",
      "command": "actual shell command",
      "description": "What this command does",
      "sortOrder": 0
    }
  ]
}
```

### Service Type Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier. Lowercase alphanumeric with hyphens (`^[a-z0-9-]+$`) |
| `displayName` | `string` | Yes | Human-readable name shown in the UI |
| `commands` | `array` | Yes | List of predefined commands |

**Command fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Command slug (`^[a-z0-9-]+$`). Used in the CLI: `bridgeport run ... <name>` |
| `displayName` | `string` | Yes | Label shown in the UI |
| `command` | `string` | Yes | The shell command to execute inside the container |
| `description` | `string` | No | Brief description of what the command does |
| `sortOrder` | `integer` | No | Display order (lower numbers appear first, defaults to array index) |

### Example: Django

```json
{
  "name": "django",
  "displayName": "Django",
  "commands": [
    {
      "name": "shell",
      "displayName": "Django Shell",
      "command": "python manage.py shell",
      "description": "Interactive Django shell",
      "sortOrder": 0
    },
    {
      "name": "dbshell",
      "displayName": "Database Shell",
      "command": "python manage.py dbshell",
      "description": "Database CLI shell",
      "sortOrder": 1
    },
    {
      "name": "migrate",
      "displayName": "Run Migrations",
      "command": "python manage.py migrate",
      "description": "Apply database migrations",
      "sortOrder": 2
    },
    {
      "name": "collectstatic",
      "displayName": "Collect Static",
      "command": "python manage.py collectstatic --noinput",
      "description": "Collect static files",
      "sortOrder": 4
    }
  ]
}
```

### Creating a Custom Service Type

1. Create a new JSON file in `plugins/service-types/`:

   ```bash
   touch plugins/service-types/rails.json
   ```

2. Add the plugin definition:

   ```json
   {
     "name": "rails",
     "displayName": "Ruby on Rails",
     "commands": [
       {
         "name": "console",
         "displayName": "Rails Console",
         "command": "bundle exec rails console",
         "description": "Interactive Rails console",
         "sortOrder": 0
       },
       {
         "name": "migrate",
         "displayName": "Run Migrations",
         "command": "bundle exec rails db:migrate",
         "description": "Apply database migrations",
         "sortOrder": 1
       },
       {
         "name": "routes",
         "displayName": "Show Routes",
         "command": "bundle exec rails routes",
         "description": "Display all routes",
         "sortOrder": 2
       }
     ]
   }
   ```

3. Restart BridgePort. The new type will appear in the service type dropdown.

---

## Database Type Plugins

Database types define connection fields, backup/restore commands, shell commands, and optionally monitoring queries for collecting database metrics.

### Database Type JSON Schema

```json
{
  "name": "lowercase-with-hyphens",
  "displayName": "Human Readable Name",
  "defaultPort": 5432,
  "connectionFields": [...],
  "backupCommand": "...",
  "restoreCommand": "...",
  "commands": [...],
  "monitoring": {
    "connectionMode": "sql",
    "driver": "pg",
    "queries": [...]
  }
}
```

### Database Type Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier (`^[a-z0-9-]+$`) |
| `displayName` | `string` | Yes | Human-readable name |
| `defaultPort` | `integer` | No | Default connection port |
| `connectionFields` | `array` | Yes | Fields shown when adding a database of this type |
| `backupCommand` | `string` | No | Command template for backups (uses `{{placeholders}}`) |
| `restoreCommand` | `string` | No | Command template for restoring backups |
| `commands` | `array` | No | Predefined shell commands (same format as service type commands) |
| `monitoring` | `object` | No | Monitoring configuration for collecting metrics |

### Connection Fields

Connection fields define the form shown when adding a database of this type.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Field identifier (used in command placeholders, e.g., `host`) |
| `label` | `string` | Yes | Display label (e.g., `"Host"`) |
| `type` | `string` | Yes | Input type: `"text"`, `"number"`, or `"password"` |
| `required` | `boolean` | No | Whether the field is required |
| `default` | `any` | No | Default value |

### Commands and Placeholders

Backup commands, restore commands, and shell commands support `{{placeholder}}` template syntax. Placeholders are replaced with actual values at execution time.

**Available placeholders:**

| Placeholder | Source |
|-------------|--------|
| `{{host}}` | Database host |
| `{{port}}` | Database port |
| `{{username}}` | Database username |
| `{{password}}` | Database password |
| `{{databaseName}}` | Database name |
| `{{filePath}}` | File path (for SQLite) |
| `{{outputFile}}` | Backup output file path (generated by BridgePort) |
| `{{inputFile}}` | Restore input file path |

**Example backup command:**

```
pg_dump --no-password -h {{host}} -p {{port}} -U {{username}} -d {{databaseName}} -f "{{outputFile}}"
```

### Monitoring Queries

The `monitoring` section defines how BridgePort collects metrics from databases of this type.

**Monitoring configuration:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connectionMode` | `string` | Yes | `"sql"` for direct database connections, `"ssh"` for command execution via SSH, `"redis"` for Redis INFO commands |
| `driver` | `string` | Conditional | Node.js driver for SQL connections: `"pg"` or `"mysql2"`. Required when `connectionMode` is `"sql"` |
| `queries` | `array` | Yes | List of monitoring queries |

**Query definition:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique query identifier (used as the key in stored metrics) |
| `displayName` | `string` | Yes | Label shown in the monitoring UI |
| `query` | `string` | Yes | The SQL query, shell command, or Redis command to execute |
| `resultType` | `string` | Yes | How to interpret results: `"scalar"`, `"row"`, or `"rows"` |
| `unit` | `string` | No | Display unit (e.g., `"bytes"`, `"%"`, `"s"`) |
| `chartGroup` | `string` | No | Group queries together on the same chart |
| `resultMapping` | `object` | No | Maps column names to result field names (for `rows` type) |

**Result types explained:**

| Type | Description | Query example |
|------|-------------|---------------|
| `scalar` | Returns a single value from a column named `value` | `SELECT count(*) AS value FROM users` |
| `row` | Returns a single row with named columns | `SELECT version() AS version, current_database() AS database` |
| `rows` | Returns multiple rows (tables, top-N queries) | `SELECT name, size FROM tables ORDER BY size DESC LIMIT 10` |

For `scalar` queries, BridgePort reads the `value` column from the first row. For `rows` queries, use `resultMapping` to define which columns map to which display fields.

### Example: PostgreSQL

```json
{
  "name": "postgres",
  "displayName": "PostgreSQL",
  "defaultPort": 5432,
  "connectionFields": [
    { "name": "host", "label": "Host", "type": "text", "required": true, "default": "localhost" },
    { "name": "port", "label": "Port", "type": "number", "required": true, "default": 5432 },
    { "name": "databaseName", "label": "Database Name", "type": "text", "required": true },
    { "name": "username", "label": "Username", "type": "text", "required": true },
    { "name": "password", "label": "Password", "type": "password", "required": true }
  ],
  "backupCommand": "pg_dump --no-password -h {{host}} -p {{port}} -U {{username}} -d {{databaseName}} -f \"{{outputFile}}\"",
  "restoreCommand": "pg_restore --no-password -h {{host}} -p {{port}} -U {{username}} -d {{databaseName}} \"{{inputFile}}\"",
  "commands": [
    {
      "name": "shell",
      "displayName": "PostgreSQL Shell",
      "command": "psql -h {{host}} -p {{port}} -U {{username}} {{databaseName}}",
      "description": "Interactive PostgreSQL shell",
      "sortOrder": 0
    },
    {
      "name": "vacuum",
      "displayName": "Vacuum Analyze",
      "command": "psql -h {{host}} -p {{port}} -U {{username}} -d {{databaseName}} -c \"VACUUM ANALYZE\"",
      "description": "Run VACUUM ANALYZE",
      "sortOrder": 1
    }
  ],
  "monitoring": {
    "connectionMode": "sql",
    "driver": "pg",
    "queries": [
      {
        "name": "dbSize",
        "displayName": "Database Size",
        "query": "SELECT pg_database_size(current_database()) AS value",
        "resultType": "scalar",
        "unit": "bytes"
      },
      {
        "name": "tableCount",
        "displayName": "Table Count",
        "query": "SELECT count(*) AS value FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        "resultType": "scalar"
      },
      {
        "name": "deadTupleRatio",
        "displayName": "Dead Tuple Ratio",
        "query": "SELECT CASE WHEN ... END AS value FROM pg_stat_user_tables",
        "resultType": "scalar",
        "unit": "%"
      },
      {
        "name": "topTableSizes",
        "displayName": "Top Tables by Size",
        "query": "SELECT schemaname || '.' || relname AS name, pg_total_relation_size(relid) AS size, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10",
        "resultType": "rows",
        "resultMapping": { "name": "name", "size": "size", "rows": "rows" }
      }
    ]
  }
}
```

### Creating a Custom Database Type

Here is an example creating a monitoring-enabled ClickHouse plugin:

1. Create `plugins/database-types/clickhouse.json`:

   ```json
   {
     "name": "clickhouse",
     "displayName": "ClickHouse",
     "defaultPort": 8123,
     "connectionFields": [
       { "name": "host", "label": "Host", "type": "text", "required": true, "default": "localhost" },
       { "name": "port", "label": "Port", "type": "number", "required": true, "default": 8123 },
       { "name": "databaseName", "label": "Database", "type": "text", "required": true, "default": "default" },
       { "name": "username", "label": "Username", "type": "text", "default": "default" },
       { "name": "password", "label": "Password", "type": "password" }
     ],
     "commands": [
       {
         "name": "client",
         "displayName": "ClickHouse Client",
         "command": "clickhouse-client --host {{host}} --port 9000 --user {{username}} --database {{databaseName}}",
         "description": "Interactive ClickHouse client",
         "sortOrder": 0
       }
     ],
     "monitoring": {
       "connectionMode": "ssh",
       "queries": [
         {
           "name": "dbSize",
           "displayName": "Database Size",
           "query": "clickhouse-client --host {{host}} --port 9000 -q \"SELECT sum(bytes_on_disk) FROM system.parts WHERE database = '{{databaseName}}'\"",
           "resultType": "scalar",
           "unit": "bytes"
         },
         {
           "name": "tableCount",
           "displayName": "Table Count",
           "query": "clickhouse-client --host {{host}} --port 9000 -q \"SELECT count() FROM system.tables WHERE database = '{{databaseName}}'\"",
           "resultType": "scalar"
         }
       ]
     }
   }
   ```

2. Restart BridgePort. ClickHouse will appear in the database type dropdown.

---

## Plugin Lifecycle

### Startup Sync

On every server startup, `syncPlugins()` reads all JSON files from `plugins/service-types/` and `plugins/database-types/`, validates them, and synchronizes them to the database.

The sync result is logged to the console:

```
[Plugins] Syncing plugins from ./plugins
[Plugins] Sync complete: 2 created, 3 updated, 0 errors
```

### Smart Merge Behavior

When syncing plugins, BridgePort handles three cases:

| Scenario | Behavior |
|----------|----------|
| **Type does not exist** | Created from the JSON file. Source set to `"plugin"`. |
| **Type exists and is NOT customized** | Fully replaced with the JSON file contents (commands are deleted and recreated). |
| **Type exists and IS customized** | Only new commands (by name) are added. Existing commands and display name are preserved. |

This means you can safely update plugin JSON files and restart BridgePort -- your admin's UI customizations will not be overwritten. However, any new commands added to the JSON file will be picked up automatically.

### The `isCustomized` Flag

Each service type and database type has an `isCustomized` boolean flag:

- **`false`** (default for plugin-sourced types): The type can be fully overwritten by plugin sync
- **`true`** (set when an admin edits via the UI): Plugin sync will only add new commands, not replace existing ones

The `source` field tracks origin:
- `"plugin"`: Created from a JSON file
- `"user"`: Created manually through the admin UI

### Resetting to Defaults

If a type has been customized through the UI, you can reset it to the original plugin definition:

1. Go to **Admin > Service Types** or **Admin > Database Types**
2. Click the **Reset** button on a customized type

This reads the original JSON file, replaces all commands, and sets `isCustomized` back to `false`.

> [!NOTE]
> Reset only works for types that have a corresponding JSON file in the plugins directory. User-created types (source: `"user"`) cannot be reset.

### Exporting as JSON

Any type (plugin-sourced or user-created) can be exported as a JSON file to the plugins directory:

1. Go to **Admin > Service Types** or **Admin > Database Types**
2. Click the **Export** button

This writes the current state (including any UI customizations) as a JSON file to the plugins directory. The exported file will be picked up by future plugin syncs.

---

## Built-In Plugins

BridgePort ships with these plugins:

**Service Types:**

| Name | Display Name | Commands |
|------|-------------|----------|
| `django` | Django | shell, dbshell, migrate, makemigrations, collectstatic, createsuperuser |
| `nodejs` | Node.js | repl, npm-install, npm-build, npm-test |
| `generic` | Generic | sh, bash |

**Database Types:**

| Name | Display Name | Port | Monitoring | Connection Mode |
|------|-------------|------|------------|-----------------|
| `postgres` | PostgreSQL | 5432 | Yes | SQL (`pg` driver) |
| `mysql` | MySQL | 3306 | Yes | SQL (`mysql2` driver) |
| `sqlite` | SQLite | -- | Yes | SSH |
| `mongodb` | MongoDB | 27017 | No | -- |
| `redis` | Redis | 6379 | Yes | Redis |

---

## Related Docs

- [CLI Reference](cli.md) -- `bridgeport run` uses service type commands
- [Environment Settings](environment-settings.md) -- Database monitoring intervals
- [System Settings](system-settings.md) -- Plugins directory configuration
