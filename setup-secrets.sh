#!/bin/bash
# setup-secrets.sh - Script to create Docker secrets for the monitor app
# 
# This script creates the necessary Docker secrets for the monitoring system.
# It reads passwords interactively and stores them in Docker's encrypted secret store.
#
# Usage: ./setup-secrets.sh
#
# The script will:
# 1. Create the nodes_config secret from secrets/nodes_config.json
# 2. Prompt for SSH passwords for each remote server configured in nodes_config.json
# 3. Create Docker secrets for each password

set -e

echo "================================================"
echo "Docker Swarm Monitor - Secrets Setup"
echo "================================================"
echo ""

# Check if running in Swarm mode
if ! docker info | grep -q "Swarm: active"; then
    echo "ERROR: Docker Swarm is not initialized!"
    echo "Run: docker swarm init"
    exit 1
fi

# Check if nodes_config.json exists
if [ ! -f "secrets/nodes_config.json" ]; then
    echo "ERROR: secrets/nodes_config.json not found!"
    echo "Please create it first with your node configurations."
    exit 1
fi

echo "1. Creating nodes_config secret..."
if docker secret ls | grep -q "nodes_config"; then
    echo "   Secret 'nodes_config' already exists. Updating..."
    docker secret rm nodes_config
fi
docker secret create nodes_config secrets/nodes_config.json
echo "   ✓ nodes_config secret created"
echo ""

# Extract remote servers from nodes_config.json
echo "2. Creating SSH password secrets..."
echo ""

# Read the JSON and extract SSH remote servers
REMOTE_SERVERS=$(grep -o '"name": "[^"]*"' secrets/nodes_config.json | grep -v '"name": "local"' | cut -d'"' -f4)

if [ -z "$REMOTE_SERVERS" ]; then
    echo "   No remote servers configured. Skipping SSH password setup."
    echo ""
else
    for SERVER_NAME in $REMOTE_SERVERS; do
        ec o "   Server: $SERVER_NAME"
        
        # Check if secret already exists
        if docker secret ls | grep -q "ssh_password_$SERVER_NAME"; then
            echo "   Secret already exists. Do you want to update it? (y/n)"
            read -r UPDATE
            if [ "$UPDATE" != "y" ]; then
                echo "   Skipped."
                echo ""
                continue
            fi
            docker secret rm ssh_password_$SERVER_NAME
        fi
        
        # Prompt for password
        echo "   Enter SSH password for $SERVER_NAME:"
        read -rs PASSWORD
        echo ""
        
        # Confirm password
        echo "   Confirm password:"
        read -rs PASSWORD_CONFIRM
        echo ""
        
        if [ "$PASSWORD" != "$PASSWORD_CONFIRM" ]; then
            echo "   ERROR: Passwords don't match!"
            exit 1
        fi
        
        # Create secret
        echo "$PASSWORD" | docker secret create ssh_password_$SERVER_NAME -
        echo "   ✓ Secret created: ssh_password_$SERVER_NAME"
        echo ""
    done
fi

echo "================================================"
echo "✓ All secrets created successfully!"
echo "================================================"
echo ""
