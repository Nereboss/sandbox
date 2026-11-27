# Network access

Sandbox restricts outbound traffic to allowed domains.

# Base network policies

During interactive user or project initialization, sandbox provides three base network default:

- **Restricted** adds hosts for selected tools and their dependencies. Other workflows can need more hosts.
- **Balanced** also allows common GitHub, GitLab, and Bitbucket hosts. These services can receive data and serve user-controlled content.
- **Broad** also allows shared cloud and hosting wildcards, including `*.amazonaws.com` and `*.googleapis.com`. These can include user-controlled services and buckets. Broad is the weakest network boundary.

# Tool specific allows

For each tool configured to be available in the sandbox, some tool specific domains are allowed. These can be reviewed in the generated `allow_network` list in the user or project `config.toml`.

## Allow a service

Add an entry to the configuration:

```toml
allow_network = [
  "api.example.com",
  "*.example.net",
  "git.example.com:{22,443}",
  "db.example.com:5432",
  "service.example.org:*",
]
```

Or allow one for a single run:

```bash
sandbox --allow-network api.example.com run claude
```

Without a port, entries allow ports 80 and 443.
`*.example.net` includes the base domain and all subdomains.
`host:*` and `host:{*}` allow all TCP ports for that host.

Entries accumulate across configuration layers.
Remove an unwanted entry from the file that defines it.

## Find a blocked request

While the affected container is running:

```bash
sandbox network logs
sandbox network logs --status=all
sandbox network allow
```

The first command shows blocked requests.
The second includes allowed requests.
The third lets you select logged destinations and add them to configuration.

Check for redirect and download hosts as well as the original service.
For a detailed diagnostic bundle:

```bash
sandbox network logs --raw > sandbox-network-debug.log
```

Use `--no-resolve` to skip reverse DNS lookups.
Logs can omit repeated blocked traffic and IPv6 connections.
Reported names can differ from requested names when services share an IP address.
Review logs for sensitive data before sharing them.

## Protocol limits

HTTP, HTTPS, SSH, and Git over SSH use the managed proxy.
Other protocols must support proxy tunneling.
Allowing `db.example.com:5432` does not make a direct database connection work automatically.

IPv4 and IPv6 firewall rules block direct external connections in restricted mode.
Private addresses are not a general bypass.
Exact runtime host aliases resolve to a host gateway, but do not grant access to its ports.
Literal IPv4 proxy destinations require an explicit allowlist entry for that address.

## Unrestricted access

```bash
sandbox --full-network run claude
```

This disables domain filtering.
The proxy remains active unless you also use `--no-proxy`.
Use unrestricted access only when you accept the wider network access.
Prefer logs over disabling restrictions to diagnose a missing domain.

The agent user cannot change the firewall after startup, but container root can.
Allowed domains can still receive project data.
See [security limits](SECURITY.md).
