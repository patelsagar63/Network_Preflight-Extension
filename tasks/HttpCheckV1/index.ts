import tl = require('azure-pipelines-task-lib/task');
import { setTimeout as delay } from 'timers/promises';
import fs = require('fs');
import path = require('path');


// Publish a Markdown job summary using Azure Pipelines logging command
function publishSummary(name: string, fileBase: string, markdown: string) {
  const dir = process.env['AGENT_TEMPDIRECTORY'] || process.cwd();
  const filePath = path.join(dir, fileBase);
  fs.writeFileSync(filePath, markdown, { encoding: 'utf8' });
  // Attach as a job summary
  console.log(
    `##vso[task.addattachment type=Distributedtask.Core.Summary;name=${name}]${filePath}`
  );
}

// Parse comma/range expressions like "200,204,301-302,200-399"
function parseStatusExpr(expr: string) {
  const parts = expr.split(',').map(s => s.trim()).filter(Boolean);
  return (code: number) => parts.some(p => {
    const [a, b] = p.split('-').map(Number);
    return Number.isFinite(b) ? (code >= a && code <= b) : code === a;
  });
}

async function checkOnce(url: string, method: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = { method, signal: controller.signal };

  const started = Date.now();
  const res = await fetch(url, init);
  const latency = Date.now() - started;
  clearTimeout(timer);

  const server = res.headers.get('server') ?? undefined;
  const via = res.headers.get('via') ?? undefined;

  return { status: res.status, ok: res.ok, latency, server, via };
}

async function run() {
  try {
    const targets = tl.getDelimitedInput('targets', '\n', true).filter(Boolean);
    const method = tl.getInput('method', true)!;
    const timeoutMs = Number(tl.getInput('timeoutSeconds', false) || '10') * 1000;
    const retries = Number(tl.getInput('retries', false) || '0');
    const expectStatusExpr = tl.getInput('expectStatus', false) || '200-399';
    const maxLatencyMs = Number(tl.getInput('maxLatencyMs', false) || '0');

    const expectStatus = parseStatusExpr(expectStatusExpr);

    type Result = { url: string; passed: boolean; status?: number; latency?: number; error?: string; server?: string; via?: string; };
    const results: Result[] = [];

    for (const url of targets) {
      let attempt = 0, lastErr: any, r: any = {}, passed = false;
      while (attempt <= retries && !passed) {
        try {
          r = await checkOnce(url, method, timeoutMs);
          passed = expectStatus(r.status) && (!maxLatencyMs || r.latency <= maxLatencyMs);
        } catch (e: any) {
          lastErr = e;
        }
        if (!passed && attempt++ < retries) await delay(250 * attempt);
      }
      results.push({ url, passed, ...r, error: r.status ? undefined : (lastErr?.message ?? 'unknown error') });
      tl.debug(JSON.stringify(results[results.length - 1]));
    }

    // Build and publish Markdown job summary
    const lines: string[] = [
      `# Network Preflight — HTTP(S)`,
      `| URL | Status | Latency (ms) | OK |`,
      `|---|---:|---:|:--:|`
    ];
    for (const r of results) {
      lines.push(`| ${r.url} | ${r.status ?? r.error} | ${r.latency ?? '-'} | ${r.passed ? '✅' : '❌'} |`);
    }
    publishSummary('Network Preflight — HTTP(S)', 'http-summary.md', lines.join('\n'));

    const failed = results.filter(r => !r.passed).map(r => r.url);
    tl.setVariable('NetworkPreflight.FailedTargets', failed.join(','));
    failed.length
      ? tl.setResult(tl.TaskResult.Failed, `HTTP check failed for: ${failed.join(', ')}`)
      : tl.setResult(tl.TaskResult.Succeeded, 'All HTTP checks passed');
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err.message ?? String(err));
  }
}
run();
