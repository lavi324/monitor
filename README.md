# Docker Swarm Monitor - Setup Instructions

## Step-by-Step Setup:

### Step 1: Edit Your Server List
Open `secrets/nodes_config.json` and change:
- **"name"**: Server name - use simple names without spaces.
- **"host"**: Replace with your actual server IP address.
- **"username"**: Change if not using "root".

**Important:** 
Server names must NOT contain spaces or special characters (use underscores: "prod_server" not "Prod Server")

For local monitoring only, keep just the "local" type. For remote servers, add more entries with their IPs.

### Step 2: Create Password Secrets
Make the setup script executable:
```bash
chmod +x setup-secrets.sh
```

Run it (it will ask for SSH passwords):
```bash
./setup-secrets.sh
```

**What happens:** The script will prompt you to type the SSH password for each remote server. Just type it and press Enter.


### Step 4: Deploy the Monitor
```bash
./deploy.sh -f monitor
```

Wait 30 seconds for services to start.

---

### Step 5: Open the Monitor
Open your web browser and go to:

```
http://IP_ADDRESS:8081
```

## How to Use

1. **Switch servers**: Click the dropdown at the top → select a server
2. **View service logs**: Click the "📋 Logs" button on any service
3. **See unhealthy services**: Red alerts appear at the top automatically


**Need to change a password?**
```bash
# Delete old secret:
docker secret rm ssh_password_remote1

# Create new one:
echo "your_new_password" | docker secret create ssh_password_remote1 -

# Restart:
docker stack deploy -c docker-compose.yml monitor
```

---

## Adding More Servers

To monitor additional servers:

### 1. Add Server to Config
Edit `secrets/nodes_config.json` and add a new entry:
```json
{
  "name": "remote3",
  "type": "ssh",
  "host": "192.168.1.102",
  "port": 22,
  "username": "root"
}
```

### 2. Update docker-compose.yml
Add the new secret to the backend service:
```yaml
services:
  backend:
    secrets:
      - nodes_config
      - ssh_password_remote1
      - ssh_password_remote2
      - ssh_password_remote3    # ← Add this line
```

Also add it to the secrets section at the bottom:
```yaml
secrets:
  nodes_config:
    external: true
  ssh_password_remote1:
    external: true
  ssh_password_remote2:
    external: true
  ssh_password_remote3:       # ← Add these 2 lines
    external: true
```

### 3. Create the Secret & Redeploy
```bash
# Run setup script (will detect the new server):
./setup-secrets.sh

# Redeploy the stack:
docker stack deploy -c docker-compose.yml monitor
```

Done! The new server will appear in the dropdown.
