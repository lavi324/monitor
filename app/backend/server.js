// Docker Swarm Monitor backend.
//
// The monitor stack MUST be deployed on a swarm MANAGER node (enforced by a
// placement constraint in docker-compose.yml). Everything is discovered
// automatically through the manager's Docker socket — no secrets, IPs,
// usernames or passwords:
//   - Cluster nodes come from `docker node ls` and are shown by node name
//     (matching Portainer/docker node list) instead of long node IDs.
//   - Services and their per-node placement come from the swarm task list.
//   - Service logs are fetched cluster-wide via the manager's service-logs API.

const express = require('express');
const Docker = require('dockerode');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Portal referrer gate: the monitor may only be used when the visit started
// from the portal page (http://<ip>/ng/portal or https://<ip>/ng/portal).
// Once the UI has loaded, its own requests (API calls, images) carry the
// monitor page itself as referrer, so same-host referrers stay allowed.
// nginx enforces the same gate for the UI files via auth_request ->
// /api/portal-gate (the HTML never passes through this backend otherwise).
// NOTE: the Referer header is client-controlled — this is a soft access
// gate, not real authentication.
// ---------------------------------------------------------------------------
const PORTAL_REFERRER_PATTERN = /^https?:\/\/[^/]+\/ng\/portal(?:[/?#]|$)/i;

function isAllowedReferrer(req) {
  const referrer = req.get('referer') || '';
  if (PORTAL_REFERRER_PATTERN.test(referrer)) return true;
  try {
    // Same-host: requests issued by the already-approved monitor UI itself.
    // Compare hostnames only — nginx strips the port from the Host header.
    const refHost = new URL(referrer).hostname;
    const reqHost = (req.get('host') || '').replace(/:\d+$/, '');
    return refHost !== '' && refHost === reqHost;
  } catch {
    return false; // missing or malformed referrer
  }
}

app.use((req, res, next) => {
  if (req.path === '/api/health' || req.path === '/api/portal-gate') return next(); // internal requests, no referrer
  if (!isAllowedReferrer(req)) {
    return res.status(403).json({ error: 'Access denied: open the monitor from the portal (/ng/portal)' });
  }
  next();
});

// nginx auth_request target: reaching this handler means the gate middleware
// above already approved the request's referrer.
app.get('/api/portal-gate', (req, res) => res.sendStatus(204));

const MAX_LOG_ROWS = 10000;

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Swarm state: the backend must run on a manager of an active swarm.
// ---------------------------------------------------------------------------
let selfNodeId = null;
let swarmReady = false;
let swarmError = 'Swarm state has not been checked yet';

async function checkSwarm() {
  try {
    const info = await withTimeout(docker.info(), 10000, 'docker info');
    const state = info.Swarm?.LocalNodeState;
    if (state !== 'active') {
      swarmReady = false;
      swarmError = `Docker Swarm is not active on this node (state: ${state || 'unknown'}). Run "docker swarm init" and redeploy.`;
    } else if (!info.Swarm?.ControlAvailable) {
      swarmReady = false;
      swarmError = 'The monitor is not running on a swarm MANAGER node. Deploy the stack on a manager.';
    } else {
      selfNodeId = info.Swarm.NodeID;
      swarmReady = true;
      swarmError = null;
    }
  } catch (err) {
    swarmReady = false;
    swarmError = `Unable to query the Docker daemon: ${err.message}`;
  }
  if (!swarmReady) console.error(`Swarm check failed: ${swarmError}`);
  return swarmReady;
}

// ---------------------------------------------------------------------------
// Cluster snapshot: nodes + services + tasks in one cached fetch.
// ---------------------------------------------------------------------------
const CLUSTER_CACHE_TTL = 2500;
let clusterCache = { timestamp: 0, snapshot: null, promise: null };

function nodeDisplayName(node) {
  const bySpecName = node.Spec?.Name;
  const byHostname = node.Description?.Hostname;
  return bySpecName || byHostname || node.ID;
}

async function buildClusterSnapshot() {
  if (!swarmReady && !(await checkSwarm())) {
    throw new Error(swarmError || 'Swarm is not available');
  }

  // `status: true` asks the daemon to include ServiceStatus (running/desired
  // task counts) with each service, for both replicated and global modes.
  const [rawNodes, services, tasks] = await Promise.all([
    withTimeout(docker.listNodes(), 15000, 'node list'),
    withTimeout(docker.listServices({ status: true }), 15000, 'service list'),
    withTimeout(docker.listTasks(), 15000, 'task list')
  ]);

  const nodes = rawNodes.map(n => ({
    id: n.ID,
    name: nodeDisplayName(n),
    hostname: n.Description?.Hostname || 'unknown',
    role: n.Spec?.Role || 'worker',
    leader: Boolean(n.ManagerStatus?.Leader),
    status: n.Status?.State || 'unknown'
  }));
  // Stable board order: managers first (leader first), then workers.
  nodes.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'manager' ? -1 : 1;
    if (a.leader !== b.leader) return a.leader ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const nodesById = new Map();
  const nodesByName = new Map();
  for (const n of nodes) {
    nodesById.set(n.id, n);
    nodesByName.set(n.name, n);
  }

  const tasksByService = new Map();
  for (const t of tasks) {
    const list = tasksByService.get(t.ServiceID);
    if (list) list.push(t);
    else tasksByService.set(t.ServiceID, [t]);
  }
  // Newest task first — used for "latest task state / error message".
  for (const list of tasksByService.values()) {
    list.sort((a, b) => Date.parse(b.CreatedAt || 0) - Date.parse(a.CreatedAt || 0));
  }

  return { nodes, nodesById, nodesByName, services, tasksByService };
}

async function getCluster() {
  const now = Date.now();
  if (clusterCache.snapshot && now - clusterCache.timestamp < CLUSTER_CACHE_TTL) {
    return clusterCache.snapshot;
  }
  if (!clusterCache.promise) {
    clusterCache.promise = buildClusterSnapshot()
      .then(snapshot => {
        clusterCache = { timestamp: Date.now(), snapshot, promise: null };
        return snapshot;
      })
      .catch(err => {
        clusterCache.promise = null;
        throw err;
      });
  }
  // Serve the stale snapshot while a refresh is in flight instead of blocking.
  if (clusterCache.snapshot) return clusterCache.snapshot;
  return clusterCache.promise;
}

function resolveNode(cluster, nodeName) {
  if (!nodeName) return null;
  return cluster.nodesByName.get(nodeName)
    || cluster.nodesById.get(nodeName)
    || cluster.nodes.find(n => n.hostname === nodeName)
    || null;
}

// The node that "owns" services with no assigned tasks (scaled to 0 replicas /
// nothing schedulable): the backend's own node, falling back to the leader.
function fallbackNode(cluster) {
  return (selfNodeId && cluster.nodesById.get(selfNodeId))
    || cluster.nodes.find(n => n.leader)
    || cluster.nodes[0]
    || null;
}

// Cluster-wide running/desired counts for a service. Prefers the daemon's
// ServiceStatus; falls back to computing from the task list.
function serviceClusterCounts(service, tasks) {
  const status = service.ServiceStatus || {};
  let running = status.RunningTasks;
  let desired = status.DesiredTasks;
  if (typeof running !== 'number') {
    running = tasks.filter(t => t.Status?.State === 'running').length;
  }
  if (typeof desired !== 'number') {
    desired = service.Spec?.Mode?.Replicated
      ? (service.Spec.Mode.Replicated.Replicas ?? 0)
      : tasks.filter(t => t.DesiredState === 'running').length;
  }
  return { running, desired };
}

// ---------------------------------------------------------------------------
// Health check endpoint
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  if (!swarmReady) {
    return res.status(503).json({ status: 'error', message: swarmError });
  }
  res.json({ status: 'ok', message: 'Docker Swarm Monitor API is running' });
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
app.get('/api/nodes-list', async (req, res) => {
  try {
    const cluster = await getCluster();
    res.json(cluster.nodes.map(n => ({
      name: n.name,
      host: n.hostname,
      type: 'swarm',
      role: n.role,
      status: n.status
    })));
  } catch (error) {
    console.error('Error fetching nodes list:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Services per node (the board columns)
// ---------------------------------------------------------------------------
app.get('/api/services', async (req, res) => {
  const { nodeName } = req.query;
  if (!nodeName) {
    return res.status(400).json({ error: 'nodeName parameter is required' });
  }

  try {
    const cluster = await getCluster();
    const node = resolveNode(cluster, nodeName);
    if (!node) return res.json([]);

    const pinNode = fallbackNode(cluster);
    const isPinNode = pinNode && pinNode.id === node.id;

    const result = [];
    for (const service of cluster.services) {
      const tasks = cluster.tasksByService.get(service.ID) || [];
      const onNode = tasks.filter(t => t.NodeID === node.id);
      const runningOnNode = onNode.filter(t => t.Status?.State === 'running').length;
      const desiredOnNode = onNode.filter(t => t.DesiredState === 'running').length;
      const hasPresence = runningOnNode > 0 || desiredOnNode > 0;

      // Services with no live task anywhere (e.g. scaled to 0, or nothing
      // schedulable yet) stay visible on the monitor's own node so they can
      // still be inspected and started from the board.
      const assignedAnywhere = tasks.some(t => t.DesiredState === 'running' && t.NodeID);
      if (!hasPresence && !(isPinNode && !assignedAnywhere)) continue;

      let running = runningOnNode;
      let desired = desiredOnNode;
      if (!hasPresence) {
        const counts = serviceClusterCounts(service, tasks);
        running = counts.running;
        desired = counts.desired;
      }

      result.push({
        id: service.ID,
        name: service.Spec?.Name || service.ID,
        status: desired > 0 && running >= desired ? 'healthy' : 'unhealthy'
      });
    }

    res.json(result);
  } catch (error) {
    console.error(`Error fetching services for ${nodeName}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Unhealthy services summary (messages section / favicon)
// ---------------------------------------------------------------------------
// Cache latest task state / error per service so the message doesn't flicker
// while swarm rapidly restarts a crashing task: as long as running/desired
// don't change, the previously shown state is kept.
const errorMessageCache = new Map(); // serviceId -> { taskState, errorMessage, running, desired }

app.get('/api/messages', async (req, res) => {
  try {
    const cluster = await getCluster();
    const pinNode = fallbackNode(cluster);
    const messages = [];

    for (const service of cluster.services) {
      const tasks = cluster.tasksByService.get(service.ID) || [];
      const { running, desired } = serviceClusterCounts(service, tasks);
      const isHealthy = desired > 0 && running >= desired;

      if (isHealthy) {
        errorMessageCache.delete(service.ID);
        continue;
      }

      // Latest task (tasks are sorted newest first) drives the shown state.
      const latestTask = tasks[0];
      let taskState = latestTask?.Status?.State || 'unknown';
      let errorMessage = null;
      if (!latestTask) {
        taskState = 'unknown';
        errorMessage = 'No tasks found';
      } else if (taskState === 'failed' || taskState === 'rejected') {
        errorMessage = latestTask.Status?.Err || latestTask.Status?.Message || 'Task failed';
      } else if (taskState === 'running') {
        errorMessage = 'Not enough running replicas';
      }

      const cached = errorMessageCache.get(service.ID);
      if (cached && cached.running === running && cached.desired === desired) {
        taskState = cached.taskState;
        errorMessage = cached.errorMessage;
      } else {
        errorMessageCache.set(service.ID, { taskState, errorMessage, running, desired });
      }

      // Attribute the message to the node of the most recent task with a
      // placement; otherwise to the monitor's own node.
      const placedTask = tasks.find(t => t.NodeID);
      const nodeInfo = (placedTask && cluster.nodesById.get(placedTask.NodeID)) || pinNode;

      messages.push({
        nodeName: nodeInfo ? nodeInfo.name : 'swarm',
        serviceId: service.ID,
        serviceName: service.Spec?.Name || service.ID,
        status: 'unhealthy',
        running,
        desired,
        taskState,
        errorMessage,
        timestamp: new Date().toISOString()
      });
    }

    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error.message);
    res.json([{
      nodeName: 'swarm',
      status: 'error',
      error: `Unable to query the swarm: ${error.message}`,
      timestamp: new Date().toISOString()
    }]);
  }
});

// ---------------------------------------------------------------------------
// Log parsing helpers
// ---------------------------------------------------------------------------
const LOG_LEVEL_PATTERN = /\b(INFO|DEBUG|WARN|WARNING|ERROR|TRACE|FATAL|INF|ERR|WRN|DBG)\b/i;
const STACKTRACE_CONTINUATION_PATTERN = /^(?:at\s+\S|\.\.\.\s+\d+\s+more$|Caused by:|Suppressed:|Wrapped by:)/;
// NOTE: must stay linear-time. A nested quantifier like
// /^(?:[a-zA-Z_$][\w$.]+)*(?:Exception|Error)(?::|$)/ causes catastrophic
// backtracking (ReDoS) on long word-ish lines and pegs the event loop at
// 100% CPU. The flat char class below matches the same class-name shapes
// (e.g. java.lang.NullPointerException:) without nesting.
const EXCEPTION_LINE_PATTERN = /^[\w$.]*(?:Exception|Error)(?::|$)/;

const normalizeLogLine = (line) => String(line || '')
  .replace(/\r/g, '')
  .replace(/\u001b\[[0-9;]*m/g, '')
  .replace(/^[\u0000-\u001f]+/, '');

const decodeDockerLogPayload = (value) => {
  if (!Buffer.isBuffer(value)) return String(value || '');

  // Docker non-TTY logs may use an 8-byte multiplexed frame header.
  // Decode framed payload safely; if format doesn't match, fall back to plain text.
  const chunks = [];
  let offset = 0;
  let framed = false;

  while (offset + 8 <= value.length) {
    const streamType = value[offset];
    const payloadLen = value.readUInt32BE(offset + 4);
    const frameEnd = offset + 8 + payloadLen;

    if ((streamType !== 1 && streamType !== 2) || frameEnd > value.length) {
      framed = false;
      break;
    }

    framed = true;
    chunks.push(value.slice(offset + 8, frameEnd));
    offset = frameEnd;
  }

  if (framed && offset === value.length) {
    return Buffer.concat(chunks).toString('utf8');
  }

  return value.toString('utf8');
};

const extractSessionId = (value) => {
  const sessionMatch = String(value || '').match(/\[([a-zA-Z0-9_-]+(?:::|:)\d+)\]/);
  let sessionId = sessionMatch ? sessionMatch[1] : null;
  if (sessionId && !sessionId.includes('::') && sessionId.length <= 15) {
    sessionId = null;
  }
  return sessionId;
};

const cleanLogMessage = (value) => {
  let cleanedMessage = String(value || '');

  cleanedMessage = cleanedMessage.replace(/^.*?\b(INFO|DEBUG|WARN|WARNING|ERROR|TRACE|FATAL|INF|ERR|WRN|DBG)\b\s*/, '');
  cleanedMessage = cleanedMessage.replace(/^\d{4}-\d{2}-\d{2}T[\d:.+-]*Z?\s*/, '');

  let prevMessage = '';
  while (cleanedMessage !== prevMessage && /^\[[^\]]+\]\s*/.test(cleanedMessage)) {
    prevMessage = cleanedMessage;
    cleanedMessage = cleanedMessage.replace(/^\[[^\]]+\]\s*/, '');
  }

  const dashIndex = cleanedMessage.indexOf(' - ');
  if (dashIndex > 0) {
    const afterDash = cleanedMessage.substring(dashIndex + 3);
    if (/^(OK|finished|completed|SUCCESS|FAILED)/i.test(afterDash)) {
      cleanedMessage = cleanedMessage.substring(0, dashIndex);
    }
  }

  return cleanedMessage.trimEnd();
};

const detectLogLevel = (value) => {
  const messageLower = String(value || '').toLowerCase();
  if (messageLower.includes('error') || messageLower.includes('fatal') || messageLower.includes('exception')) return 'error';
  if (messageLower.includes('warn')) return 'warning';
  if (messageLower.includes('debug')) return 'debug';
  return 'info';
};

const buildParsedEntry = ({ timestamp, rawMessage, fallbackFlowId }) => {
  const message = cleanLogMessage(rawMessage);
  const explicitLevel = LOG_LEVEL_PATTERN.test(String(rawMessage || ''));
  const continuationHint = STACKTRACE_CONTINUATION_PATTERN.test(message)
    || /^\s+at\s+\S/.test(String(rawMessage || ''))
    || EXCEPTION_LINE_PATTERN.test(message);

  return {
    timestamp,
    message,
    level: detectLogLevel(rawMessage),
    flowId: extractSessionId(rawMessage) || fallbackFlowId,
    explicitLevel,
    continuationHint
  };
};

const coalesceMultilineEntries = (entries) => {
  const grouped = [];
  let current = null;

  for (const entry of entries) {
    if (!entry || !entry.message) continue;

    const shouldAppend = Boolean(
      current
      && (
        entry.continuationHint
        || (!entry.explicitLevel && current.level === 'error')
      )
    );

    if (shouldAppend) {
      current.message = `${current.message}\n${entry.message}`;
      continue;
    }

    if (current) {
      grouped.push(current);
    }

    current = { ...entry };
  }

  if (current) {
    grouped.push(current);
  }

  return grouped.map(({ explicitLevel, continuationHint, ...entry }) => entry);
};

// Parse raw service-logs output. Handles both "TIMESTAMP task.name | MESSAGE"
// (prefixed) and plain "TIMESTAMP MESSAGE" lines, falling back to the raw line.
const PREFIXED_LOG_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+[^|]+\|\s*(.*)$/;
const PLAIN_LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.*)$/;

function parseServiceLogOutput(raw, idPrefix, maxLines) {
  const text = decodeDockerLogPayload(raw);
  const allLines = text.split(/\r?\n/).filter(l => l.trim());
  const lines = allLines.length > maxLines ? allLines.slice(-maxLines) : allLines;

  const parsedLines = lines.map((line, idx) => {
    const normalizedLine = normalizeLogLine(line);

    let match = normalizedLine.match(PREFIXED_LOG_LINE);
    if (match) {
      return buildParsedEntry({
        timestamp: match[1].endsWith('Z') ? match[1] : `${match[1]}Z`,
        rawMessage: match[2],
        fallbackFlowId: `${idPrefix}-${idx}`
      });
    }

    match = normalizedLine.match(PLAIN_LOG_LINE);
    if (match) {
      return buildParsedEntry({
        timestamp: match[1].endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(match[1]) ? match[1] : `${match[1]}Z`,
        rawMessage: match[2],
        fallbackFlowId: `${idPrefix}-${idx}`
      });
    }

    return buildParsedEntry({
      timestamp: new Date().toISOString(),
      rawMessage: normalizedLine,
      fallbackFlowId: `${idPrefix}-raw-${idx}`
    });
  });

  return coalesceMultilineEntries(parsedLines);
}

// dockerode may hand back a Buffer/string (non-follow) or a stream depending
// on version — normalize both into a single Buffer.
function collectLogOutput(result, timeoutMs) {
  if (Buffer.isBuffer(result)) return Promise.resolve(result);
  if (typeof result === 'string') return Promise.resolve(Buffer.from(result));

  return new Promise((resolve, reject) => {
    const chunks = [];
    const finish = () => resolve(Buffer.concat(chunks));
    const timer = setTimeout(() => {
      try { result.destroy(); } catch {}
      finish();
    }, timeoutMs);

    result.on('data', chunk => chunks.push(Buffer.from(chunk)));
    result.on('end', () => { clearTimeout(timer); finish(); });
    result.on('close', () => { clearTimeout(timer); finish(); });
    result.on('error', err => {
      clearTimeout(timer);
      if (chunks.length) finish();
      else reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Logs for a service (cluster-wide via the manager's service-logs API)
// ---------------------------------------------------------------------------
app.get('/api/logs/:serviceId', async (req, res) => {
  const { serviceId } = req.params;
  try {
    const { count } = req.query;
    console.log(`[/api/logs/${serviceId}] Request - count: ${count}`);

    // Validate log count - max 10,000 to keep browser rendering responsive.
    const requestedCount = parseInt(count) || 50;
    if (requestedCount > MAX_LOG_ROWS) {
      return res.status(400).json({
        error: `Log count exceeds maximum limit of ${MAX_LOG_ROWS}`,
        maxLimit: MAX_LOG_ROWS
      });
    }

    const service = docker.getService(serviceId);

    // A stale/removed serviceId makes inspect() throw "no such service". Treat
    // that as a clean 404 instead of a generic 500 (the service may have been
    // removed between the board loading and this request).
    let serviceInfo;
    try {
      serviceInfo = await service.inspect();
    } catch (inspectErr) {
      if (/no such service|not found|404/i.test(inspectErr.message || '')) {
        console.log(`[/api/logs/${serviceId}] Service not found: ${inspectErr.message}`);
        return res.status(404).json({ error: 'Service not found', serviceId });
      }
      throw inspectErr;
    }

    // Keep fetch bounded for large requests so 10k retrieval stays responsive.
    const logFetchOverhead = Math.min(2000, Math.max(300, Math.floor(requestedCount * 0.1)));
    const maxRawLines = requestedCount + logFetchOverhead;
    const logFetchTimeout = Math.min(60000, 15000 + requestedCount * 3);

    let parsed = [];
    try {
      // The manager's service-logs API aggregates logs from ALL tasks of the
      // service across every node in the swarm (running, failed and shutdown).
      const raw = await withTimeout(
        service.logs({ stdout: true, stderr: true, timestamps: true, tail: maxRawLines }),
        logFetchTimeout,
        'service logs fetch'
      );
      const collected = await collectLogOutput(raw, logFetchTimeout);
      console.log(`[/api/logs/${serviceId}] Raw output length: ${collected.length} bytes`);
      parsed = parseServiceLogOutput(collected, serviceInfo.Spec?.Name || 'service', maxRawLines);
    } catch (logErr) {
      console.error(`[/api/logs/${serviceId}] Service log fetch failed:`, logErr.message);
    }

    if (parsed.length === 0) {
      // No retained logs (e.g. no containers ever started) — synthesize
      // entries from the task states so the user still sees what happened.
      const tasks = await docker.listTasks({ filters: { service: [serviceId] } }).catch(() => []);
      const synthesized = tasks
        .slice()
        .sort((a, b) => Date.parse(b.UpdatedAt || 0) - Date.parse(a.UpdatedAt || 0))
        .slice(0, requestedCount)
        .map((task, idx) => {
          const state = task.Status?.State || 'unknown';
          const err = task.Status?.Err || '';
          const statusMessage = task.Status?.Message || '';
          const message = err
            ? `Task ${task.ID.slice(0, 12)} ${state}: ${err}`
            : statusMessage
              ? `Task ${task.ID.slice(0, 12)} ${state}: ${statusMessage}`
              : `Task ${task.ID.slice(0, 12)} ${state}: no retained container logs were available`;
          const level = state === 'failed' || state === 'rejected'
            ? 'error'
            : state === 'shutdown'
              ? 'warning'
              : 'info';
          return {
            timestamp: task.UpdatedAt || new Date().toISOString(),
            message,
            level,
            flowId: `task-status-${idx}`
          };
        });

      console.log(`[/api/logs/${serviceId}] Synthesized ${synthesized.length} task-status entries`);
      return res.json(synthesized);
    }

    // Tasks on different nodes interleave in the stream — sort chronologically
    // so "last N" really is the newest N entries.
    parsed.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    console.log(`[/api/logs/${serviceId}] Parsed ${parsed.length} log entries, returning last ${requestedCount}`);
    res.json(parsed.slice(-requestedCount));
  } catch (error) {
    console.error(`[/api/logs/${serviceId}] Error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Service control endpoints (start/stop/restart) — swarm operations run
// directly against the local manager socket. nodeName is accepted for
// frontend compatibility but not needed: there is one swarm.
// ---------------------------------------------------------------------------
app.post('/api/service/:serviceId/scale', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { replicas } = req.body;

    if (typeof replicas !== 'number' || replicas < 0) {
      return res.status(400).json({ error: 'replicas must be a non-negative number' });
    }

    console.log(`[Service Control] Scaling ${serviceId} to ${replicas} replicas`);

    const service = docker.getService(serviceId);
    const serviceInfo = await service.inspect();

    if (!serviceInfo.Spec?.Mode?.Replicated) {
      return res.status(400).json({ error: 'Only replicated services can be scaled' });
    }

    await service.update({
      version: serviceInfo.Version.Index,
      ...serviceInfo.Spec,
      Mode: {
        Replicated: {
          Replicas: replicas
        }
      }
    });

    console.log(`[Service Control] Successfully scaled ${serviceId} to ${replicas} replicas`);
    res.json({ success: true, message: `Service scaled to ${replicas} replicas` });
  } catch (error) {
    console.error('Error scaling service:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/service/:serviceId/restart', async (req, res) => {
  try {
    const { serviceId } = req.params;
    console.log(`[Service Control] Restarting ${serviceId}`);

    const service = docker.getService(serviceId);
    const serviceInfo = await service.inspect();

    // Force update to restart the service
    await service.update({
      version: serviceInfo.Version.Index,
      ...serviceInfo.Spec,
      TaskTemplate: {
        ...serviceInfo.Spec.TaskTemplate,
        ForceUpdate: (serviceInfo.Spec.TaskTemplate.ForceUpdate || 0) + 1
      }
    });

    console.log(`[Service Control] Successfully restarted ${serviceId}`);
    res.json({ success: true, message: 'Service restarted' });
  } catch (error) {
    console.error('Error restarting service:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get service info (for getting current replica count)
app.get('/api/service/:serviceId/info', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const serviceInfo = await docker.getService(serviceId).inspect();

    res.json({
      id: serviceInfo.ID,
      name: serviceInfo.Spec?.Name,
      replicas: serviceInfo.Spec?.Mode?.Replicated?.Replicas ?? 0
    });
  } catch (error) {
    console.error('Error getting service info:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Live events feed: Docker Swarm service lifecycle activity.
//
// Two sources feed one bounded in-memory ring buffer:
//   1. The daemon's event stream (service/node create/update/remove) — a
//      single long-lived connection no matter how many services exist.
//   2. Task-state transitions diffed from the (already cached) cluster
//      snapshot, covering every swarm task lifecycle state.
//
// Built to survive mass restarts (400+ services at once): the diff poll is
// O(services) against the shared snapshot cache, the buffer is capped, and
// /api/events serves incremental pages purely from memory — no extra Docker
// API calls per request.
// ---------------------------------------------------------------------------
const EVENT_BUFFER_CAP = 2000;
const EVENTS_MAX_PAGE = 1000;
const TASK_LIFECYCLE_STATES = [
  'new', 'allocated', 'pending', 'assigned', 'accepted', 'preparing', 'ready',
  'starting', 'running', 'complete', 'shutdown', 'failed', 'rejected', 'remove', 'orphaned'
];

let eventSeq = 0;
const eventBuffer = []; // oldest -> newest, capped at EVENT_BUFFER_CAP

function pushEvent(evt) {
  eventBuffer.push({
    seq: ++eventSeq,
    ts: evt.ts || new Date().toISOString(),
    kind: evt.kind,
    action: evt.action,
    service: evt.service || null,
    node: evt.node || null,
    severity: evt.severity || 'info',
    message: evt.message || ''
  });
  if (eventBuffer.length > EVENT_BUFFER_CAP) {
    eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_CAP);
  }
}

function severityForTaskState(state) {
  if (state === 'failed' || state === 'rejected' || state === 'orphaned') return 'error';
  if (state === 'shutdown' || state === 'remove') return 'warning';
  if (state === 'running' || state === 'complete') return 'ok';
  return 'info';
}

function dockerEventTimestamp(ev) {
  if (ev.timeNano) return new Date(ev.timeNano / 1e6).toISOString();
  if (ev.time) return new Date(ev.time * 1000).toISOString();
  return new Date().toISOString();
}

function handleDockerEvent(ev, push = pushEvent) {
  const attrs = ev.Actor?.Attributes || {};
  const ts = dockerEventTimestamp(ev);

  if (ev.Type === 'service') {
    const name = attrs.name || String(ev.Actor?.ID || '').slice(0, 12);
    if (ev.Action === 'create') {
      push({ ts, kind: 'service', action: 'created', service: name, severity: 'info', message: 'service created' });
    } else if (ev.Action === 'remove') {
      push({ ts, kind: 'service', action: 'removed', service: name, severity: 'warning', message: 'service removed' });
    } else if (ev.Action === 'update') {
      const updateState = attrs['updatestate.new'];
      if (updateState) {
        const isRollback = updateState.includes('rollback');
        push({
          ts,
          kind: 'service',
          action: isRollback ? 'rollback' : 'updated',
          service: name,
          severity: updateState === 'paused' || isRollback ? 'warning' : 'info',
          message: `update ${updateState}`
        });
      } else {
        push({ ts, kind: 'service', action: 'updated', service: name, severity: 'info', message: 'spec updated (deploy / scale / restart)' });
      }
    }
  } else if (ev.Type === 'node') {
    const name = attrs.name || String(ev.Actor?.ID || '').slice(0, 12);
    const newState = attrs['state.new'];
    if (ev.Action === 'update' && newState && newState !== attrs['state.old']) {
      push({
        ts,
        kind: 'node',
        action: newState,
        node: name,
        severity: newState === 'ready' ? 'ok' : 'error',
        message: `node became ${newState}`
      });
    } else if (ev.Action === 'create' || ev.Action === 'remove') {
      push({
        ts,
        kind: 'node',
        action: ev.Action === 'create' ? 'joined' : 'removed',
        node: name,
        severity: 'info',
        message: ev.Action === 'create' ? 'node joined the swarm' : 'node removed from the swarm'
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 24-hour history: the feed shows the last 24h of activity, not just events
// observed since this process started.
//   - On startup the daemon's event log is replayed (service / node events)
//     and swarm task history (docker keeps a few tasks per slot) is converted
//     into status events, so a fresh monitor deploy still shows the past day.
//   - Events older than 24h are pruned from the ring buffer.
// ---------------------------------------------------------------------------
const EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pruneOldEvents() {
  const cutoff = Date.now() - EVENT_MAX_AGE_MS;
  let drop = 0;
  while (drop < eventBuffer.length && Date.parse(eventBuffer[drop].ts || 0) < cutoff) drop++;
  if (drop > 0) eventBuffer.splice(0, drop);
}

async function backfillHistoricalEvents() {
  const collected = [];
  const untilSec = Math.floor(Date.now() / 1000);
  const sinceSec = untilSec - Math.floor(EVENT_MAX_AGE_MS / 1000);

  // Daemon-recorded service / node events from the last 24 hours.
  try {
    const stream = await withTimeout(
      docker.getEvents({
        since: sinceSec,
        until: untilSec,
        filters: JSON.stringify({ type: ['service', 'node'] })
      }),
      20000, 'event history'
    );
    const raw = await withTimeout(new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }), 20000, 'event history read');
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { handleDockerEvent(JSON.parse(l), evt => collected.push(evt)); } catch { /* skip malformed frame */ }
    }
  } catch (err) {
    console.error('Event history backfill failed:', err.message);
  }

  // Task status transitions the swarm still remembers — restarts, failures
  // and starts that happened before this monitor process came up.
  try {
    const cluster = await getCluster();
    const cutoff = Date.now() - EVENT_MAX_AGE_MS;
    const namesById = new Map(cluster.services.map(s => [s.ID, s.Spec?.Name || s.ID]));
    for (const [serviceId, tasks] of cluster.tasksByService) {
      const name = namesById.get(serviceId);
      if (!name) continue;
      for (const t of tasks) {
        const state = t.Status?.State;
        const ms = Date.parse(t.Status?.Timestamp || 0);
        if (!state || Number.isNaN(ms) || ms < cutoff) continue;
        collected.push({
          ts: new Date(ms).toISOString(),
          kind: 'task',
          action: state,
          service: name,
          node: (t.NodeID && cluster.nodesById.get(t.NodeID)?.name) || null,
          severity: severityForTaskState(state),
          message: t.Status?.Err ? `task ${state} — ${t.Status.Err}` : `task ${state}`
        });
      }
    }
  } catch (err) {
    console.error('Task history backfill failed:', err.message);
  }

  // Push oldest-first so sequence numbers follow chronological order.
  collected.sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0));
  for (const evt of collected) pushEvent(evt);
  if (collected.length) console.log(`Backfilled ${collected.length} event(s) from the last 24 hours`);
}

// Single long-lived event stream with automatic reconnect. Parsing is fully
// guarded so a malformed frame or a daemon hiccup can never crash the server.
let eventStreamActive = false;
function startDockerEventStream() {
  if (eventStreamActive) return;
  eventStreamActive = true;
  docker.getEvents({ filters: JSON.stringify({ type: ['service', 'node'] }) })
    .then(stream => {
      let pending = '';
      let restarted = false;
      const restart = () => {
        if (restarted) return;
        restarted = true;
        eventStreamActive = false;
        try { stream.destroy(); } catch {}
        setTimeout(startDockerEventStream, 5000);
      };
      stream.on('data', chunk => {
        pending += chunk.toString('utf8');
        // Hard cap the reassembly buffer so it can never grow unbounded.
        if (pending.length > 1048576) pending = pending.slice(-1048576);
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) continue;
          try { handleDockerEvent(JSON.parse(line)); } catch { /* ignore malformed frame */ }
        }
      });
      stream.on('error', restart);
      stream.on('end', restart);
      stream.on('close', restart);
      console.log('Docker event stream connected');
    })
    .catch(err => {
      eventStreamActive = false;
      console.error('Docker event stream unavailable:', err.message);
      setTimeout(startDockerEventStream, 5000);
    });
}

// Task-state tracker: diff each service's latest task state / health against
// the previous poll and record transitions. Reads only the shared snapshot
// cache, so even a cluster-wide restart adds no Docker API pressure.
const lifecycleTrack = new Map(); // serviceId -> { state, healthy }
let lifecyclePollBusy = false;

async function pollLifecycleEvents() {
  if (lifecyclePollBusy) return; // never let polls stack up under load
  lifecyclePollBusy = true;
  try {
    const cluster = await getCluster();
    const seen = new Set();
    for (const service of cluster.services) {
      seen.add(service.ID);
      const name = service.Spec?.Name || service.ID;
      const tasks = cluster.tasksByService.get(service.ID) || [];
      const { running, desired } = serviceClusterCounts(service, tasks);
      const healthy = desired > 0 && running >= desired;
      const latestTask = tasks[0]; // tasks are sorted newest first
      const state = latestTask?.Status?.State || 'none';
      const nodeName = (latestTask?.NodeID && cluster.nodesById.get(latestTask.NodeID)?.name) || null;

      const prev = lifecycleTrack.get(service.ID);
      lifecycleTrack.set(service.ID, { state, healthy });
      if (!prev) continue; // first observation — nothing to compare against

      if (state !== prev.state && state !== 'none') {
        pushEvent({
          kind: 'task',
          action: state,
          service: name,
          node: nodeName,
          severity: severityForTaskState(state),
          message: prev.state === 'none' ? `task ${state}` : `task ${prev.state} → ${state}`
        });
      }
      if (healthy !== prev.healthy) {
        pushEvent(healthy
          ? { kind: 'health', action: 'recovered', service: name, node: nodeName, severity: 'ok', message: 'recovered — back online' }
          : { kind: 'health', action: 'degraded', service: name, node: nodeName, severity: 'error', message: `unhealthy — ${running}/${desired} running` });
      }
    }
    // Drop tracking state for services that no longer exist.
    for (const id of lifecycleTrack.keys()) {
      if (!seen.has(id)) lifecycleTrack.delete(id);
    }
  } catch { /* swarm busy or unreachable — next poll retries */ }
  finally { lifecyclePollBusy = false; }
}

// Incremental feed: ?since=<seq> returns only events newer than that sequence
// number, capped at ?limit (newest win). Pure in-memory read.
app.get('/api/events', (req, res) => {
  pruneOldEvents();
  const since = Number(req.query.since) || 0;
  const limit = Math.min(EVENTS_MAX_PAGE, Math.max(1, Number(req.query.limit) || 200));
  let events = since > 0
    ? eventBuffer.filter(e => e.seq > since)
    : eventBuffer.slice(-limit);
  if (events.length > limit) events = events.slice(-limit);
  res.json({
    latest: eventSeq,
    events,
    lifecycle: { taskStates: TASK_LIFECYCLE_STATES }
  });
});

// Serve static files
app.use(express.static(__dirname));

// Serve index.html as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Initialize and start server
const PORT = process.env.PORT || 3001;

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Don't exit - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - log and continue
});

checkSwarm().then((ok) => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Docker Swarm Monitor running on http://0.0.0.0:${PORT}`);
    if (ok) {
      console.log(`Connected to swarm as manager node ${selfNodeId}`);
      // Pre-warm the cluster snapshot so the first board load is instant.
      getCluster()
        .then(c => console.log(`Discovered ${c.nodes.length} node(s) and ${c.services.length} service(s)`))
        .catch(err => console.error('Cluster pre-warm failed:', err.message));
    } else {
      console.error(`NOT READY: ${swarmError}`);
      console.error('The monitor stack must be deployed on a Docker Swarm MANAGER node.');
    }
    // Live events: backfill the last 24h of history first (so sequence
    // numbers stay chronological), then attach the daemon event stream and
    // the task-lifecycle diff poller. All parts are self-healing, so start
    // them regardless of the initial swarm state.
    backfillHistoricalEvents().finally(() => {
      startDockerEventStream();
      pollLifecycleEvents();
      setInterval(pollLifecycleEvents, 3000);
      setInterval(pruneOldEvents, 60000);
    });
  });
});