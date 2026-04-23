Service Monitor - Setup Instructions

Step 1: Run Docker secrets setup:

A) Navigate to the directory that contains setup-secrets.sh.

B) Execute chmod +x setup-secrets.sh

C) Before running the script, gather all required details: how many remote nodes you want to monitor, and for each node: IP, username, and password.

D) Execute ./setup-secrets.sh

The script will first ask how many remote nodes you want to monitor, then prompt for each remote node:
- node name (what you want to call the node in the app)
- IP
- username
- password

Notes:
- The script creates a single Docker secret named nodes_config containing all remote node properties.
- Local node is added automatically by backend through Docker socket.

Step 2: Deploy the Monitor app:

A) Navigate to the directory that contains the file deploy.sh and execute ./deploy.sh -f monitor

B) Wait for services to start.

C) Step 3: Open the Monitor app

Open:
http://IP_ADDRESS:8081

Done.

______________________________________________________________
______________________________________________________________

Service Monitor - Post Deployment Updates

To add/remove/update remote nodes:
1. Remove the monitor Docker stack: 
docker stack rm monitor

2. Re-run the script:
./setup-secrets.sh

3. Redeploy:
./deploy.sh -f monitor

Done. 
