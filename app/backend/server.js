const express = require('express');
const Docker = require('dockerode');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Docker connection
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Docker Swarm Monitor API is running' });
});

// Get all services
app.get('/api/services', async (req, res) => {
  try {
    const services = await docker.listServices();
    const servicesWithStatus = await Promise.all(
      services.map(async (service) => {
        const serviceInfo = service.inspect ? await service.inspect() : service;
        const tasks = await docker.listTasks({ filters: { service: [serviceInfo.ID] } });

        const runningTasks = tasks.filter(t => t.Status.State === 'running').length;
        const totalTasks = tasks.length;
        const desiredTasks = serviceInfo.Spec.Mode.Replicated?.Replicas
          ?? serviceInfo.ServiceStatus?.DesiredTasks
          ?? tasks.filter(t => t.DesiredState === 'running').length
          ?? 0;
        const effectiveDesired = desiredTasks === 0 && runningTasks > 0 ? runningTasks : desiredTasks;
        const isHealthy = runningTasks >= effectiveDesired && effectiveDesired > 0;

        let cpuUsage = 0;
        let memoryUsage = 0;
        let diskUsage = 0;

        const runningTask = tasks.find(t => t.Status.State === 'running');
        try {
          if (runningTask && runningTask.Status.ContainerStatus?.ContainerID) {
            const container = docker.getContainer(runningTask.Status.ContainerStatus.ContainerID);
            const stats1 = await container.stats({ stream: false });
            await new Promise(resolve => setTimeout(resolve, 100));
            const stats2 = await container.stats({ stream: false });

            const cpuDelta = stats2.cpu_stats.cpu_usage.total_usage - stats1.cpu_stats.cpu_usage.total_usage;
            const systemDelta = stats2.cpu_stats.system_cpu_usage - stats1.cpu_stats.system_cpu_usage;
            const numCpus = stats2.cpu_stats.online_cpus || stats2.cpu_stats.cpu_usage.percpu_usage?.length || 1;
            if (systemDelta > 0 && cpuDelta >= 0) {
              cpuUsage = (cpuDelta / systemDelta) * numCpus * 100;
            }

            const memUsed = stats2.memory_stats.usage || 0;
            const memLimit = stats2.memory_stats.limit || 1;
            if (memLimit > 0) {
              memoryUsage = (memUsed / memLimit) * 100;
            }
            diskUsage = 0;
          }
        } catch (err) {
          console.error(`Error getting stats for ${serviceInfo.Spec.Name}:`, err.message);
        }

        return {
          id: serviceInfo.ID,
          name: serviceInfo.Spec.Name,
          status: isHealthy ? 'healthy' : 'unhealthy',
          running: runningTasks,
          desired: effectiveDesired,
          total: totalTasks,
          image: serviceInfo.Spec.TaskTemplate.ContainerSpec?.Image || 'unknown',
          mode: serviceInfo.Spec.Mode.Replicated ? 'replicated' : 'global',
          cpuUsage: Math.round(cpuUsage * 10) / 10,
          memoryUsage: Math.round(memoryUsage * 10) / 10,
          diskUsage: Math.round(diskUsage * 10) / 10,
          tasks: tasks.map(t => ({
            id: t.ID,
            nodeId: t.NodeID,
            status: t.Status.State,
            containerStatus: t.Status.ContainerStatus?.State || 'unknown'
          }))
        };
      })
    );
    res.json(servicesWithStatus);
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get nodes information
app.get('/api/nodes', async (req, res) => {
  try {
    const nodes = await docker.listNodes();
    const nodesInfo = nodes.map(node => ({
      id: node.ID,
      hostname: node.Description?.Hostname || 'unknown',
      status: node.Status?.State || 'unknown',
      availability: node.Spec?.Availability || 'active',
      role: node.Spec?.Role || 'worker'
    }));
    res.json(nodesInfo);
  } catch (error) {
    console.error('Error fetching nodes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to get CPU usage - Alpine Linux uses different format
async function getCpuUsage() {
  try {
    // Try reading from /proc/stat first (more accurate), fall back to top if needed
    const { stdout: statOutput } = await execPromise(`grep "^cpu " /proc/stat | awk '{idle=$5; sum=$2+$3+$4+$5+$6+$7+$8+$9+$10; print 100*((sum-idle)/sum)}'`);
    let usage = parseFloat(statOutput.trim());
    
    // If that fails, use top
    if (isNaN(usage)) {
      const { stdout: topOutput } = await execPromise(`top -bn1 | grep "CPU:" | awk '{idle=$8; gsub("%","",idle); print 100-idle}'`);
      usage = parseFloat(topOutput.trim());
    }
    
    return isNaN(usage) ? 0 : Math.round(usage * 10) / 10;
  } catch (err) {
    console.error('Error reading CPU stats:', err);
    return 0;
  }
}

// Helper function to get memory usage - use /proc/meminfo for accuracy
async function getMemoryUsage() {
  try {
    const { stdout } = await execPromise(`awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {avail=$2} END {printf "%.1f", (total-avail)/total*100}' /proc/meminfo`);
    const usage = parseFloat(stdout.trim());
    return isNaN(usage) ? 0 : Math.round(usage * 10) / 10;
  } catch (err) {
    console.error('Error reading memory stats:', err);
    return 0;
  }
}

// Helper function to get disk usage
async function getDiskUsage() {
  try {
    const { stdout } = await execPromise("df / | tail -1 | awk '{print $5}' | sed 's/%//'");
    const usage = parseFloat(stdout.trim());
    return isNaN(usage) ? 0 : Math.round(usage * 10) / 10;
  } catch (err) {
    console.error('Error reading disk stats:', err);
    return 0;
  }
}

// Get system usage statistics
app.get('/api/usage', async (req, res) => {
  try {
    // Disable caching for real-time data
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Get real CPU usage
    const cpuUsage = await getCpuUsage();
    
    // Get real memory usage
    const memoryUsage = await getMemoryUsage();
    
    // Get real disk usage
    const diskUsage = await getDiskUsage();
    
    res.json({
      cpu: cpuUsage,
      memory: memoryUsage,
      disk: diskUsage
    });
  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get logs for a specific service
app.get('/api/logs/:serviceId', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { type, count, from, to, fromMs, toMs } = req.query;
    
    // Validate log count - max 100,000
    const requestedCount = parseInt(count) || 50;
    if (requestedCount > 100000) {
      return res.status(400).json({ 
        error: 'Log count exceeds maximum limit of 100,000',
        maxLimit: 100000
      });
    }
    
    // Resolve service info and tasks before reading logs
    const service = docker.getService(serviceId);
    const serviceInfo = await service.inspect();
    const tasks = await docker.listTasks({
      filters: { service: [serviceId] }
    });

    if (!tasks || tasks.length === 0) {
      return res.json([]);
    }
      // Build log options
      const logOptions = { stdout: true, stderr: true, timestamps: true };
      if (type === 'latest') {
        logOptions.tail = Math.max(requestedCount * 100, 500000);
      } else {
        logOptions.tail = 'all';
      }
      if (type === 'range') {
        if (fromMs && toMs) {
          logOptions.since = Math.floor(Number(fromMs) / 1000);
          logOptions.until = Math.floor(Number(toMs) / 1000);
        } else if (from && to) {
          logOptions.since = Math.floor(new Date(from).getTime() / 1000);
          logOptions.until = Math.floor(new Date(to).getTime() / 1000);
        }
      }

      // Parser helper
      const parseLogs = (raw, namePrefix) => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
        const lines = text.split('\n').filter(l => l.trim());
        const regexTs = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.+)$/;
        return lines.map((line, index) => {
          const cleanLine = line.length > 8 ? line.substring(8) : line;
          const m = cleanLine.match(regexTs);
          let iso = new Date().toISOString();
          let msg = cleanLine;
          if (m) { iso = m[1]; msg = m[2]; }
          const sessionMatch = msg.match(/\[([^\]]+::\d+)\]/);
          const sessionId = sessionMatch ? sessionMatch[1] : null;
          const cleanedMessage = msg.replace(/\[[^\]]+\]\s*/, '').trim();
          let level = 'info';
          if (cleanedMessage.match(/error|fail|exception/i)) level = 'error';
          else if (cleanedMessage.match(/warn/i)) level = 'warning';
          else if (cleanedMessage.match(/debug/i)) level = 'debug';
          return { timestamp: iso, message: cleanedMessage, level, flowId: sessionId || `${namePrefix}-${index}` };
        });
      };

      if (type === 'latest') {
        // Determine health: running tasks should meet desired replicas
        const runningTasks = tasks.filter(t => t.Status.State === 'running').length;
        const desiredTasks = serviceInfo.Spec.Mode.Replicated?.Replicas
          ?? serviceInfo.ServiceStatus?.DesiredTasks
          ?? tasks.filter(t => t.DesiredState === 'running').length
          ?? 0;
        const effectiveDesired = desiredTasks === 0 && runningTasks > 0 ? runningTasks : desiredTasks;
        const isHealthy = runningTasks >= effectiveDesired && effectiveDesired > 0;

        const pickLogsFromContainer = async (cid, namePrefix) => {
          const c = docker.getContainer(cid);
          const raw = await c.logs(logOptions);
          const parsed = parseLogs(raw, namePrefix);
          return parsed && parsed.length > 0 ? parsed.slice(-requestedCount) : null;
        };

        // Healthy: prefer the current running task; Unhealthy: search recent tasks with logs
        if (isHealthy) {
          const runningTask = tasks.find(t => t.Status.State === 'running');
          if (runningTask && runningTask.Status.ContainerStatus?.ContainerID) {
            const parsed = await pickLogsFromContainer(runningTask.Status.ContainerStatus.ContainerID, serviceInfo.Spec.Name);
            if (parsed) return res.json(parsed);
          }
          return res.json([]);
        }

        // Unhealthy: walk tasks by recency to find any container that has logs
        const getTaskTime = (t) => {
          const ts = Date.parse(
            t.UpdatedAt || t.Status?.Timestamp || t.Status?.StartedAt || t.CreatedAt || 0
          );
          return Number.isNaN(ts) ? 0 : ts;
        };

        const tasksByRecency = [...tasks]
          .sort((a, b) => getTaskTime(b) - getTaskTime(a));

        for (const t of tasksByRecency) {
          const cid = t.Status?.ContainerStatus?.ContainerID;
          if (!cid) continue;
          try {
            const parsed = await pickLogsFromContainer(cid, serviceInfo.Spec.Name);
            if (parsed) return res.json(parsed);
          } catch (e) {
            continue; // try next task if this one's logs are unavailable
          }
        }
        return res.json([]);
      }

      // Range: aggregate all tasks
      let allParsed = [];
      for (const t of tasks) {
        const cid = t.Status?.ContainerStatus?.ContainerID;
        if (!cid) continue;
        try {
          const c = docker.getContainer(cid);
          const raw = await c.logs(logOptions);
          const parsed = parseLogs(raw, `${serviceInfo.Spec.Name}-${t.ID.substring(0,6)}`);
          allParsed = allParsed.concat(parsed);
        } catch {}
      }
      const fromEpoch = logOptions.since ? logOptions.since * 1000 : null;
      const toEpoch = logOptions.until ? logOptions.until * 1000 : null;
      const filtered = allParsed.filter(l => {
        const ts = Date.parse(l.timestamp);
        if (Number.isNaN(ts)) return false;
        if (fromEpoch !== null && ts < fromEpoch) return false;
        if (toEpoch !== null && ts > toEpoch) return false;
        return true;
      }).sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      return res.json(filtered);
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stream logs for a specific service (Server-Sent Events)
app.get('/api/logs/:serviceId/stream', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { since } = req.query;
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
    
    // Get service to find tasks
    const service = docker.getService(serviceId);
    const serviceInfo = await service.inspect();
    
    // Get tasks for this service
    const tasks = await docker.listTasks({
      filters: { service: [serviceId] }
    });
    
    if (tasks.length === 0) {
      res.write('data: []\n\n');
      return res.end();
    }
    
    // Get logs from the first running task
    const runningTask = tasks.find(t => t.Status.State === 'running');
    if (!runningTask || !runningTask.Status.ContainerStatus?.ContainerID) {
      res.write('data: []\n\n');
      return res.end();
    }
    
    const container = docker.getContainer(runningTask.Status.ContainerStatus.ContainerID);
    
    // Build log options for streaming
    const logOptions = {
      stdout: true,
      stderr: true,
      timestamps: true,
      follow: true,
      tail: 0 // Don't fetch old logs, only new ones
    };
    
    if (since) {
      logOptions.since = Math.floor(Number(since) / 1000);
    }
    
    const logStream = await container.logs(logOptions);
    
    // Parse and send logs as they arrive - one by one
    let buffer = '';
    
    logStream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      // Send each log immediately, one by one
      for (const line of lines) {
        if (!line.trim()) continue;
        
        // Remove docker log prefix (8 bytes)
        const cleanLine = line.substring(8);
        
        // Try to parse timestamp
        const timestampMatch = cleanLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.+)$/);
        
        let isoTimestamp = new Date().toISOString();
        let message = cleanLine;
        
        if (timestampMatch) {
          isoTimestamp = timestampMatch[1];
          message = timestampMatch[2];
        }
        
        // Extract session id like [abcdef::2]
        const sessionMatch = message.match(/\[([^\]]+::\d+)\]/);
        const sessionId = sessionMatch ? sessionMatch[1] : null;
        const cleanedMessage = message.replace(/\[[^\]]+\]\s*/, '').trim();
        
        // Detect log level from cleaned message
        let level = 'info';
        if (cleanedMessage.match(/error|fail|exception/i)) level = 'error';
        else if (cleanedMessage.match(/warn/i)) level = 'warning';
        else if (cleanedMessage.match(/debug/i)) level = 'debug';
        
        // Send single log immediately
        const singleLog = {
          timestamp: isoTimestamp,
          message: cleanedMessage,
          level,
          flowId: sessionId || `${serviceInfo.Spec.Name}-${Date.now()}`
        };
        
        res.write(`data: ${JSON.stringify([singleLog])}\n\n`);
      }
    });
    
    logStream.on('error', (err) => {
      console.error('Log stream error:', err);
      res.end();
    });
    
    // Clean up on client disconnect
    req.on('close', () => {
      logStream.destroy();
      res.end();
    });
    
  } catch (error) {
    console.error('Error streaming logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve static files
app.use(express.static(__dirname));

// Serve index.html as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Docker Swarm Monitor running on http://0.0.0.0:${PORT}`);
});
