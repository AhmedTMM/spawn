/**
 * gateway-resilience.test.ts — Verifies that startGateway() produces a
 * systemd unit with auto-restart and a cron heartbeat, so the openclaw
 * gateway recovers from crashes without manual intervention.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

// ── Mock @clack/prompts (must be before importing agent-setup) ──────────
const clack = mockClackPrompts();

// ── Import the function under test ──────────────────────────────────────
const { startGateway } = await import("../shared/agent-setup");
import type { CloudRunner } from "../shared/agent-setup";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Decode a base64 string embedded in the deploy script. */
function extractBase64Payload(script: string, label: string): string {
  // The script has: printf '%s' '<BASE64>' | base64 -d ...
  // We find the base64 block by locating known context around it.
  // Wrapper goes to openclaw-gateway-wrapper, unit goes to .unit.tmp
  const lines = script.split("\n");
  for (const line of lines) {
    if (!line.includes(label)) {
      continue;
    }
    const match = line.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
    if (match) {
      return Buffer.from(match[1], "base64").toString("utf-8");
    }
  }
  return "";
}

function createMockRunner(): {
  runner: CloudRunner;
  capturedScript: () => string;
} {
  let script = "";
  const runner: CloudRunner = {
    runServer: mock(async (cmd: string) => {
      script = cmd;
    }),
    uploadFile: mock(async () => {}),
  };
  return {
    runner,
    capturedScript: () => script,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("startGateway", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("systemd unit has Restart=always for crash recovery", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const unit = extractBase64Payload(capturedScript(), "openclaw-gateway.unit.tmp");
    expect(unit).toContain("Restart=always");
    stderrSpy.mockRestore();
  });

  it("systemd unit has RestartSec=5 for fast recovery", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const unit = extractBase64Payload(capturedScript(), "openclaw-gateway.unit.tmp");
    expect(unit).toContain("RestartSec=5");
    stderrSpy.mockRestore();
  });

  it("systemd unit starts after network.target", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const unit = extractBase64Payload(capturedScript(), "openclaw-gateway.unit.tmp");
    expect(unit).toContain("After=network.target");
    stderrSpy.mockRestore();
  });

  it("installs cron heartbeat that checks port 18789", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const script = capturedScript();
    // Cron line: nc -z 127.0.0.1 18789 || restart
    expect(script).toContain("nc -z 127.0.0.1 18789");
    expect(script).toContain("crontab");
    expect(script).toContain("openclaw-gateway");
    stderrSpy.mockRestore();
  });

  it("wrapper script sources .spawnrc and execs openclaw gateway", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const wrapper = extractBase64Payload(capturedScript(), "openclaw-gateway-wrapper");
    expect(wrapper).toContain('source "$HOME/.spawnrc"');
    expect(wrapper).toContain("exec openclaw gateway");
    stderrSpy.mockRestore();
  });

  it("enables and restarts the systemd service", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const script = capturedScript();
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain("systemctl enable openclaw-gateway");
    expect(script).toContain("systemctl restart openclaw-gateway");
    stderrSpy.mockRestore();
  });

  it("falls back to setsid/nohup on non-systemd systems", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const script = capturedScript();
    expect(script).toContain("setsid");
    expect(script).toContain("nohup");
    stderrSpy.mockRestore();
  });

  it("waits up to 300s for gateway port to become available", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const script = capturedScript();
    expect(script).toContain("elapsed -lt 300");
    expect(script).toContain(":18789");
    stderrSpy.mockRestore();
  });

  it("uses multiple port-check methods (ss, /dev/tcp, nc)", async () => {
    const { runner, capturedScript } = createMockRunner();
    await startGateway(runner);

    const script = capturedScript();
    expect(script).toContain("ss -tln");
    expect(script).toContain("/dev/tcp/127.0.0.1/18789");
    expect(script).toContain("nc -z 127.0.0.1 18789");
    stderrSpy.mockRestore();
  });
});
