#!/bin/bash
# setup-secrets.sh - Script to create Docker secrets for the monitor app
#
# Creates:
# - ssh_password_<nodeName> for each node with type "ssh"

set -euo pipefail

TTY=/dev/tty
if [ ! -r "$TTY" ]; then
    echo "ERROR: No interactive terminal available ($TTY not readable)."
    echo "Run this script from an interactive shell."
    exit 1
fi

secret_exists() {
    local secret_name="$1"
    docker secret ls --format '{{.Name}}' | grep -Fqx "$secret_name"
}

is_yes() {
    # Accept: y, yes (case-insensitive)
    local v
    v="${1:-}"
    v="${v,,}"
    [ "$v" = "y" ] || [ "$v" = "yes" ]
}

echo "================================================"
echo "Docker Swarm Monitor - Secrets Setup"
echo "================================================"
echo ""

# Check if running in Swarm mode (Docker secrets require Swarm + manager)
SWARM_STATE=$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)
IS_MANAGER=$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || true)

if [ "$SWARM_STATE" != "active" ]; then
    echo "ERROR: Docker Swarm is not active for this Docker daemon."
    echo "Run: docker swarm init"
    exit 1
fi

if [ "$IS_MANAGER" != "true" ]; then
    echo "ERROR: This node is not a Swarm manager; it cannot create secrets."
    echo "Run this script on a manager node (or set DOCKER_HOST to a manager)."
    exit 1
fi

# Check if nodes_config.json exists (used to discover which SSH password secrets to create)
if [ ! -f "secrets/nodes_config.json" ]; then
    echo "ERROR: secrets/nodes_config.json not found!"
    echo "Please create it first with your node configurations."
    exit 1
fi

# Extract remote servers from nodes_config.json
echo "1. Creating SSH password secrets..."
echo ""

# Read the JSON and extract SSH remote servers (by type, not by name)
# We use python3 (more reliable than grep and doesn't require jq).
# Output format per line: name|host|port|username
REMOTE_SERVERS=$(python3 - <<'PY'
import json
import sys

path = 'secrets/nodes_config.json'
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception as e:
    print(f"ERROR: failed to parse {path} as JSON: {e}", file=sys.stderr)
    sys.exit(2)

names = []
for node in data if isinstance(data, list) else []:
    if not isinstance(node, dict):
        continue
    if str(node.get('type', '')).strip() != 'ssh':
        continue
    name = str(node.get('name', '')).strip()
    host = str(node.get('host', '')).strip()
    port = node.get('port', 22)
    username = str(node.get('username', 'root')).strip() or 'root'
    if not name:
        continue
    # Basic safety: avoid breaking bash parsing
    if '|' in name or '|' in host or '|' in username:
        print(f"ERROR: node fields must not contain '|': name={name}", file=sys.stderr)
        sys.exit(2)
    names.append((name, host, str(port), username))

for name, host, port, username in sorted(names, key=lambda x: x[0]):
    print(f"{name}|{host}|{port}|{username}")
PY
)

if [ $? -eq 2 ]; then
    echo ""
    echo "ERROR: secrets/nodes_config.json must be valid JSON."
    echo "Fix it and re-run ./setup-secrets.sh"
    exit 1
fi

if [ -z "$REMOTE_SERVERS" ]; then
    echo "   No remote servers configured. Skipping SSH password setup."
    echo ""
else
    while IFS='|' read -r SERVER_NAME SERVER_HOST SERVER_PORT SERVER_USER; do
        [ -z "$SERVER_NAME" ] && continue

        echo "------------------------------------------------"
        echo "SSH password required for ${SERVER_NAME}:"
        echo ""
        
        # Check if secret already exists
        if secret_exists "ssh_password_$SERVER_NAME"; then
            read -r -p "Secret ssh_password_${SERVER_NAME} already exists. Update it? (yes/no): " UPDATE <"$TTY"
            if ! is_yes "$UPDATE"; then
                echo "Skipped."
                echo ""
                continue
            fi
            docker secret rm ssh_password_$SERVER_NAME
        fi
        
        # Prompt for password
        read -r -s -p "Password: " PASSWORD <"$TTY"
        echo ""
        
        # Confirm password
        read -r -s -p "Confirm password: " PASSWORD_CONFIRM <"$TTY"
        echo ""

        if [ -z "${PASSWORD}" ]; then
            echo "ERROR: Password cannot be empty."
            exit 1
        fi
        
        if [ "$PASSWORD" != "$PASSWORD_CONFIRM" ]; then
            echo "ERROR: Passwords don't match!"
            exit 1
        fi
        
        # Create secret
        printf "%s" "$PASSWORD" | docker secret create ssh_password_$SERVER_NAME -
        echo "✓ Secret created: ssh_password_$SERVER_NAME"
        echo ""
    done <<< "$REMOTE_SERVERS"
fi

echo "================================================"
echo "✓ All secrets created successfully!"
echo "================================================"
echo ""
