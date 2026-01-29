Service Monitor - Setup Instructions


Step 1: Edit the list of servers you want to monitor
Open `secrets/nodes_config.json` and adjust the following properties to match your environment:

- "name": Server name - use simple names without spaces.

- "type": Choose "ssh" for remote node or choose "local" for the local node that runs the monitor app.

- "host": Replace with your actual server IP address.

- "port": The port that you want to use SSH with.

- "username": The server username.


Note: You do NOT need an SSH password secret for a node with "type": "local". 
The monitor connects to the local node through the Docker socket, not via SSH.


Step 2: Create a Docker Secret for every server password


Navigate to the directory that contains the setup-secrets.sh file.


Make the setup script executable:
Example: chmod +x setup-secrets.sh


Run the setup script (it will ask for the passwords):
./setup-secrets.sh


Step 3: Deploy the Monitor

Navigate to the directory that contains the deploy.sh file and the monitor directory and execute:
./deploy.sh -f monitor


Wait for services to start.

Step 4: Open the Monitor app
Find the IP address of the server where the Monitor app is deployed, then open your web browser and navigate to:

http://IP_ADDRESS:8081

Done.

______________________________________________________________
______________________________________________________________


Service Monitor – Post-Deployment Configuration & Updates


A) To monitor additional servers if you already deployed the app:

1. Add Server to Config
Edit `secrets/nodes_config.json` and add a new entry:

For an example:
{
  "name": "proc4",
  "type": "ssh",
  "host": "192.168.1.102",
  "port": 22,
  "username": "root"
}


2. Update docker-compose.yml
Add the new secret to the backend service:

services:
  backend:
    secrets:
      - ssh_password_proc2
      - ssh_password_proc3
      - ssh_password_proc4    # ← Add this line


3. Also add it to the secrets section at the bottom:
secrets:
  ssh_password_proc2:
    external: true
  ssh_password_proc3:
    external: true
  ssh_password_proc4:       # ← Add these 2 lines
    external: true


4. Create the Secret & Redeploy

Run setup script (will detect the new server):
./setup-secrets.sh

Redeploy the stack:
./deploy.sh -f monitor

Done! The new server will appear in the Node dropdown.
