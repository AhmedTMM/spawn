#!/usr/bin/env bun

// benchmark-tarballs.ts — Benchmark tarball install vs live install on a fresh VM
// Usage: bun run src/benchmark-tarballs.ts <ssh-host>
// Example: bun run src/benchmark-tarballs.ts root@159.203.139.212

import * as v from "valibot";

const host = process.argv[2];
if (!host) {
  console.error("Usage: bun run src/benchmark-tarballs.ts <user@host>");
  console.error("  Provide an SSH host for a fresh Ubuntu VM (e.g. from spawn)");
  process.exit(1);
}

const REPO = "OpenRouterTeam/spawn";

interface AgentTiming {
  agent: string;
  tarballMs: number | null;
  liveMs: number | null;
  tarballSize: string;
}

// Live install commands (same as agent-setup.ts)
const LIVE_INSTALLS: Record<
  string,
  {
    cmd: string;
    timeout: number;
  }
> = {
  claude: {
    cmd: 'curl --proto "=https" -fsSL https://claude.ai/install.sh | bash',
    timeout: 300,
  },
  codex: {
    cmd: "npm install -g @openai/codex",
    timeout: 120,
  },
  openclaw: {
    cmd: "npm install -g openclaw",
    timeout: 300,
  },
  opencode: {
    cmd: [
      'OC_ARCH=$(uname -m); case "$OC_ARCH" in aarch64) OC_ARCH=arm64;; x86_64) OC_ARCH=x64;; esac',
      "OC_OS=$(uname -s | tr A-Z a-z)",
      'mkdir -p /tmp/opencode-install "$HOME/.opencode/bin"',
      'curl --proto "=https" -fsSL -o /tmp/opencode-install/oc.tar.gz "https://github.com/sst/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz"',
      "tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install",
      'mv /tmp/opencode-install/opencode "$HOME/.opencode/bin/"',
      "rm -rf /tmp/opencode-install",
    ].join(" && "),
    timeout: 120,
  },
  kilocode: {
    cmd: "npm install -g @kilocode/cli",
    timeout: 120,
  },
  hermes: {
    cmd: 'curl --proto "=https" -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
    timeout: 300,
  },
};

// Skip zeroclaw live install (10 min Rust build)
const ZEROCLAW_ESTIMATED_LIVE_MS = 480_000; // ~8 min average

const ReleaseAssetSchema = v.object({
  name: v.string(),
  browser_download_url: v.string(),
  size: v.number(),
});

const ReleaseResponseSchema = v.object({
  assets: v.array(ReleaseAssetSchema),
});

async function ssh(
  cmd: string,
  timeout = 120,
): Promise<{
  stdout: string;
  ms: number;
}> {
  const start = performance.now();
  const proc = Bun.spawn(
    [
      "ssh",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      host,
      cmd,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const timer = setTimeout(() => proc.kill(), timeout * 1000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const code = await proc.exited;
  const ms = performance.now() - start;
  if (code !== 0) {
    throw new Error(`SSH failed (exit ${code}): ${stderr.slice(0, 200)}`);
  }
  return {
    stdout: stdout.trim(),
    ms,
  };
}

async function getTarballUrl(agent: string): Promise<{
  url: string;
  size: number;
} | null> {
  const tag = `agent-${agent}-latest`;
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return null;
    }
    const json: unknown = await resp.json();
    const parsed = v.safeParse(ReleaseResponseSchema, json);
    if (!parsed.success) {
      return null;
    }
    const asset = parsed.output.assets.find((a) => a.name.endsWith(".tar.gz"));
    if (!asset) {
      return null;
    }
    return {
      url: asset.browser_download_url,
      size: asset.size,
    };
  } catch {
    return null;
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function bar(ms: number, maxMs: number, width: number, char = "█"): string {
  const len = Math.max(1, Math.round((ms / maxMs) * width));
  return char.repeat(len);
}

async function main() {
  const agents = [
    "claude",
    "codex",
    "openclaw",
    "opencode",
    "kilocode",
    "zeroclaw",
    "hermes",
  ];
  const results: AgentTiming[] = [];

  console.log(`\n  Benchmarking tarball vs live install on ${host}\n`);

  // Ensure node is available for npm agents
  console.log("  Preparing VM...");
  try {
    await ssh(
      "command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)",
      120,
    );
  } catch {
    console.log("  (node setup failed, npm agents may skip)");
  }

  for (const agent of agents) {
    process.stdout.write(`  ${agent.padEnd(12)} `);

    // Get tarball info
    const tarball = await getTarballUrl(agent);
    let tarballMs: number | null = null;
    let tarballSize = "N/A";

    if (tarball) {
      tarballSize = formatBytes(tarball.size);
      try {
        // Clean slate
        await ssh(
          "rm -rf /root/.npm-global /root/.claude /root/.local /root/.cargo /root/.opencode /root/.bun /root/.spawn-tarball 2>/dev/null; true",
          10,
        );
        const { ms } = await ssh(
          `curl -fsSL --connect-timeout 10 --max-time 120 -L '${tarball.url}' | tar xz -C /`,
          150,
        );
        tarballMs = ms;
      } catch {
        tarballMs = null;
      }
    }

    // Live install
    let liveMs: number | null = null;
    if (agent === "zeroclaw") {
      liveMs = ZEROCLAW_ESTIMATED_LIVE_MS;
      process.stdout.write(`tarball: ${tarballMs ? formatMs(tarballMs) : "N/A"} | live: ~8min (estimated)\n`);
    } else {
      const live = LIVE_INSTALLS[agent];
      if (live) {
        try {
          // Clean slate
          await ssh(
            "rm -rf /root/.npm-global /root/.claude /root/.local /root/.cargo /root/.opencode /root/.bun /root/.spawn-tarball 2>/dev/null; true",
            10,
          );
          const { ms } = await ssh(live.cmd, live.timeout);
          liveMs = ms;
        } catch {
          liveMs = null;
        }
      }
      process.stdout.write(
        `tarball: ${tarballMs ? formatMs(tarballMs) : "N/A"} | live: ${liveMs ? formatMs(liveMs) : "N/A"}\n`,
      );
    }

    results.push({
      agent,
      tarballMs,
      liveMs,
      tarballSize,
    });
  }

  // Generate chart
  const maxMs = Math.max(...results.map((r) => Math.max(r.liveMs || 0, r.tarballMs || 0)));
  const chartWidth = 50;

  console.log("\n");
  console.log("  ┌─────────────────────────────────────────────────────────────────────┐");
  console.log("  │           Agent Install Speed: Tarball vs Live Install              │");
  console.log("  ├─────────────────────────────────────────────────────────────────────┤");

  for (const r of results) {
    const label = r.agent.padEnd(10);
    if (r.tarballMs) {
      const tBar = bar(r.tarballMs, maxMs, chartWidth, "█");
      console.log(`  │ ${label} tarball │${tBar} ${formatMs(r.tarballMs).padStart(7)} │`);
    }
    if (r.liveMs) {
      const lBar = bar(r.liveMs, maxMs, chartWidth, "░");
      const timeStr = r.agent === "zeroclaw" ? "~8min*" : formatMs(r.liveMs);
      console.log(`  │ ${label} live    │${lBar} ${timeStr.padStart(7)} │`);
    }
    console.log("  │            ─────── │" + "─".repeat(chartWidth) + "─────────│");
  }

  console.log("  │                                                                     │");
  console.log("  │  █ = tarball    ░ = live install    * = estimated (skipped)          │");
  console.log("  └─────────────────────────────────────────────────────────────────────┘");

  // Markdown table
  console.log("\n\n  Markdown table (for Slack/GitHub):\n");
  console.log("  | Agent | Tarball | Live Install | Speedup | Size |");
  console.log("  |-------|---------|-------------|---------|------|");
  for (const r of results) {
    const t = r.tarballMs ? formatMs(r.tarballMs) : "N/A";
    const l = r.liveMs ? (r.agent === "zeroclaw" ? "~8min" : formatMs(r.liveMs)) : "N/A";
    const speedup = r.tarballMs && r.liveMs ? `${(r.liveMs / r.tarballMs).toFixed(0)}x` : "—";
    console.log(
      `  | ${r.agent.padEnd(9)} | ${t.padEnd(7)} | ${l.padEnd(11)} | ${speedup.padEnd(7)} | ${r.tarballSize.padEnd(4)} |`,
    );
  }

  console.log("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
