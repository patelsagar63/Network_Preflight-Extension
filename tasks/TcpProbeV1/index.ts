import tl = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import path = require('path');
import net = require('net');
import tls = require('tls');

function publishSummary(name: string, fileBase: string, markdown: string) {
  const dir = process.env['AGENT_TEMPDIRECTORY'] || process.cwd();
  const filePath = path.join(dir, fileBase);
  fs.writeFileSync(filePath, markdown, { encoding: 'utf8' });
  console.log(`##vso[task.addattachment type=Distributedtask.Core.Summary;name=${name}]${filePath}`);
}

/**
 * Accepts:
 *   - host:port
 *   - https://host:port (or http://host:port)
 *   - [ipv6]:port
 *   - bare host (port will default based on TLS)
 */
function normalizeTarget(entry: string, defaultUseTls: boolean) {
  let raw = entry.trim();
  let useTls = defaultUseTls;
  let host: string;
  let port: number | undefined;
  let serverName: string | undefined;

  // URL form?
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    const u = new URL(raw);
    host = u.hostname;
    if (u.port) port = parseInt(u.port, 10);
    if (u.protocol === 'https:') { useTls = true;  port ??= 443; }
    if (u.protocol === 'http:')  { useTls = false; port ??= 80;  }
  } else {
    // IPv6 [addr]:port
    const m6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
    if (m6) {
      host = m6[1];
      port = parseInt(m6[2], 10);
    } else {
      // host:port (no scheme), or bare host
      const parts = raw.split(':');
      if (parts.length === 2 && !parts[0].includes('/')) {
        host = parts[0];
        port = parseInt(parts[1], 10);
      } else {
        host = raw;
      }
    }
    port ??= useTls ? 443 : 80;
  }

  // Set SNI automatically for DNS names (not IP literals)
  const isIpLiteral = net.isIP(host) !== 0;
  if (useTls && !isIpLiteral) {
    serverName = host;
  }
  return { host, port: port!, useTls, serverName };
}

function probe(host: string, port: number, timeoutMs: number, useTls: boolean, serverName?: string) {
  return new Promise<{ latency: number; alpn?: string }>((resolve, reject) => {
    const started = Date.now();

    const onOk = (sock: net.Socket | tls.TLSSocket) => {
      const latency = Date.now() - started;
      const alpn = 'alpnProtocol' in sock ? ((sock as tls.TLSSocket).alpnProtocol || undefined) : undefined;
      sock.destroy();
      resolve({ latency, alpn });
    };

    const onErr = (err: any) => {
      // Improve error details (errno, code, reason)
      const code = err?.code ? ` (${err.code})` : '';
      const reason = err?.reason ? `: ${err.reason}` : '';
      reject(new Error(`${err?.message || 'connect error'}${code}${reason}`));
    };

    const options: tls.ConnectionOptions & net.NetConnectOpts = { host, port };
    let sock: net.Socket | tls.TLSSocket;

    if (useTls) {
      (options as tls.ConnectionOptions).rejectUnauthorized = true;
      if (serverName) (options as tls.ConnectionOptions).servername = serverName;
      sock = tls.connect(options, () => onOk(sock));
    } else {
      sock = net.connect(options, () => onOk(sock));
    }

    sock.setTimeout(timeoutMs, () => { sock.destroy(); onErr(new Error('timeout')); });
    sock.on('error', onErr);
  });
}

async function run() {
  try {
    const targets = tl.getDelimitedInput('targets', '\n', true).filter(Boolean);
    const timeoutMs = Number(tl.getInput('timeoutSeconds', false) || '10') * 1000;
    const defaultUseTls = tl.getBoolInput('useTls', false);
    const serverNameOverride = tl.getInput('serverName', false);

    const results: Array<{ target: string; passed: boolean; latency?: number; alpn?: string; error?: string }> = [];

    for (const entry of targets) {
      try {
        const t = normalizeTarget(entry, defaultUseTls);
        if (serverNameOverride) t.serverName = serverNameOverride; // explicit override
        const r = await probe(t.host, t.port, timeoutMs, t.useTls, t.serverName);
        results.push({ target: `${t.host}:${t.port}`, passed: true, ...r });
      } catch (e: any) {
        results.push({ target: entry, passed: false, error: e.message });
      }
    }

    const lines = [
      `# Network Preflight — TCP`,
      `| Target | Latency (ms) | ALPN | OK |`,
      `|---|---:|:--:|:--:|`
    ];
    for (const r of results) {
      lines.push(`| ${r.target} | ${r.latency ?? '-'} | ${r.alpn ?? '-'} | ${r.passed ? '✅' : '❌'} |`);
    }
    publishSummary('Network Preflight — TCP', 'tcp-summary.md', lines.join('\n'));

    const failed = results.filter(r => !r.passed).map(r => r.target);
    failed.length
      ? tl.setResult(tl.TaskResult.Failed, `TCP unreachable: ${failed.join(', ')}`)
      : tl.setResult(tl.TaskResult.Succeeded, 'All TCP targets reachable');
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err.message ?? String(err));
  }
}
run();
