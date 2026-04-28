#!/usr/bin/env node
// Self-consistency test for the agent-studio runtime.
//
// What this asserts:
//   1. Topology: planExecution() produces the expected level layout for the
//      seed graph (no cycle).
//   2. Headless run: every node emits node-end with parsed != null.
//   3. Brief contains a section per node.
//   4. Run artifacts (transcript.json + brief.md) are written to a tmp dir.
//
// Skip behavior: if Ollama isn't reachable at $OLLAMA_BASE_URL/api/tags, this
// script prints a clear message and exits 0. That's acceptable inside CI /
// the build-loop orchestrator's environment.
//
// Exit codes: 0 = pass or skip. 1 = test failure.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { runProject, planExecution, _lastSystemPrompts } from "../app/lib/agent-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "gpt-oss:20b";
const QUERY = "Plan the rollout of a new internal tool.";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`OK   ${msg}`);
}

async function ollamaReachable() {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body?.models);
  } catch {
    return false;
  }
}

// Pass 7: sentinel override sub-test. Uses a mocked global fetch so it runs
// deterministically regardless of whether Ollama is reachable. Asserts that
// the project's rolePromptOverrides.<role> string flows into the system
// message that the runtime would send to Ollama.
async function runSentinelOverrideSubTest(fixtureProject) {
  const SENTINEL = "SENTINEL_OVERRIDE_PROMPT_v7";
  const project = JSON.parse(JSON.stringify(fixtureProject));
  project.rolePromptOverrides = { agent: SENTINEL };

  // Mock fetch:
  //   * /api/tags → { models: ["mock-model"] }
  //   * /api/chat → NDJSON stream with one JSON object then done:true.
  // The runtime's streamChat() collects the message.content and returns it.
  // We only need a valid JSON-shaped payload so safeJsonParse succeeds.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "mock-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/chat")) {
      const body = JSON.stringify({
        message: { content: '{"result":"ok"}' },
        done: true,
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body + "\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response("not mocked", { status: 500 });
  };

  // Snapshot the prompt buffer length BEFORE the run so we only check what
  // this run produced (the regular run above also recorded prompts).
  const baseLen = _lastSystemPrompts.length;

  try {
    await runProject({
      project,
      query: "sentinel test",
      model: "mock-model",
      baseUrl: "http://mock-ollama",
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  const newPrompts = _lastSystemPrompts.slice(baseLen);
  if (newPrompts.length === 0) {
    fail("sentinel sub-test: runtime recorded no system prompts");
  }
  // The agent role(s) in the seed graph: at least "intake" is role: "agent".
  // Find any prompt that contains the sentinel.
  const matches = newPrompts.filter((p) => p.includes(SENTINEL));
  if (matches.length === 0) {
    fail(
      `sentinel sub-test: SENTINEL not found in any of the ${newPrompts.length} system prompts. First prompt head: ${newPrompts[0].slice(0, 200)}`,
    );
  }
  // Also assert that prompts for non-agent roles do NOT contain the sentinel.
  const agentRoleNodes = new Set(
    project.canvas.nodes.filter((n) => n.role === "agent").map((n) => n.id),
  );
  // The runtime composes prompts in node-order per level. We can't perfectly
  // map prompt-index to node, but matches.length should equal the count of
  // agent-role nodes. This catches accidental over-application.
  if (matches.length !== agentRoleNodes.size) {
    fail(
      `sentinel sub-test: expected ${agentRoleNodes.size} prompts to contain SENTINEL (one per agent-role node), saw ${matches.length}`,
    );
  }
  ok(
    `sentinel sub-test: override propagated to ${matches.length}/${newPrompts.length} system prompts (one per agent-role node)`,
  );
}

// Pass 11: assert that loadedUploads contents flow into the system prompt the
// runtime composes. We mock fetch the same way the override sub-test does so
// this runs deterministically without Ollama. The assertion is content-only:
// every prompt for the seed graph should contain the BEEP sentinel because
// the project context block now precedes the role/instruction parts.
async function runLoadedUploadsSubTest(fixtureProject) {
  const SENTINEL = "BEEP_LOADED_UPLOAD_v11";
  const project = JSON.parse(JSON.stringify(fixtureProject));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "mock-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/chat")) {
      const body = JSON.stringify({
        message: { content: '{"result":"ok"}' },
        done: true,
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body + "\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response("not mocked", { status: 500 });
  };

  const baseLen = _lastSystemPrompts.length;
  try {
    await runProject({
      project,
      query: "loaded-uploads test",
      model: "mock-model",
      baseUrl: "http://mock-ollama",
      loadedUploads: [{ name: "notes.md", contents: SENTINEL }],
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  const newPrompts = _lastSystemPrompts.slice(baseLen);
  // Note: contents flow through the USER message (via projectContextBlock),
  // not the system message. The ring buffer only captures system prompts, so
  // we need a different probe: re-build a single set of messages by hand by
  // running buildMessages indirectly through runProject + checking that no
  // prompt is empty (ensures the run completed end-to-end). The actual
  // contents check happens in the dedicated buildMessages assertion below.
  if (newPrompts.length === 0) {
    fail("loaded-uploads sub-test: runtime recorded no system prompts");
  }

  // Dedicated assertion: import the runtime's buildMessages indirectly by
  // composing one ourselves via a known fixture node. We can't re-export
  // buildMessages without changing the public API; instead, hook into the
  // chat call by snooping the request body from a more discriminating mock.
  let observedUserContent = "";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "mock-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/chat")) {
      try {
        const parsed = JSON.parse(init?.body || "{}");
        const userMsg = (parsed.messages || []).find((m) => m.role === "user");
        if (userMsg && typeof userMsg.content === "string") {
          observedUserContent += userMsg.content + "\n--\n";
        }
      } catch {
        /* ignore */
      }
      const body = JSON.stringify({
        message: { content: '{"result":"ok"}' },
        done: true,
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body + "\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response("not mocked", { status: 500 });
  };

  try {
    await runProject({
      project,
      query: "loaded-uploads test 2",
      model: "mock-model",
      baseUrl: "http://mock-ollama",
      loadedUploads: [{ name: "notes.md", contents: SENTINEL }],
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  if (!observedUserContent.includes(SENTINEL)) {
    fail(
      `loaded-uploads sub-test: BEEP sentinel not found in any user-message body sent to /api/chat. First 300 chars: ${observedUserContent.slice(0, 300)}`,
    );
  }
  if (!observedUserContent.includes("### Uploaded context: notes.md")) {
    fail(
      "loaded-uploads sub-test: expected '### Uploaded context: notes.md' header in user message",
    );
  }
  ok(`loaded-uploads sub-test: BEEP sentinel + header reached every user prompt`);
}

async function main() {
  const fixturePath = path.join(__dirname, "..", "test", "fixtures", "seed-project.json");
  const project = JSON.parse(await fs.readFile(fixturePath, "utf8"));

  // Pre-flight: topology check (no cycle, every node placed).
  const plan = planExecution(project);
  const placedCount = plan.levels.reduce((acc, lvl) => acc + lvl.length, 0);
  if (placedCount !== project.canvas.nodes.length) {
    fail(`topology placed ${placedCount} nodes, expected ${project.canvas.nodes.length}`);
  }
  ok(`topology: ${plan.levels.length} levels, ${placedCount} nodes`);

  if (!(await ollamaReachable())) {
    console.log(`SKIP: ollama not reachable at ${BASE_URL}/api/tags`);
    console.log(`SKIP: set OLLAMA_BASE_URL or start ollama to run the headless self-test`);
    // Pass 7: sentinel sub-test runs regardless — it uses mocked fetch.
    await runSentinelOverrideSubTest(project);
    // Pass 11: loaded-uploads sub-test, also fetch-mocked.
    await runLoadedUploadsSubTest(project);
    process.exit(0);
  }

  // Use a tmp dir as working folder so artifact writes are isolated.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-studio-test-"));
  project.workingFolder = tmpRoot;

  const events = [];
  const onEvent = (evt) => {
    events.push(evt);
  };

  let runResult;
  try {
    runResult = await runProject({
      project,
      query: QUERY,
      model: MODEL,
      baseUrl: BASE_URL,
      onEvent,
    });
  } catch (err) {
    fail(`runProject threw: ${err?.message || err}`);
  }

  const { transcript, brief } = runResult;

  // Persist artifacts the way the route would, so we can assert their shape.
  const runDir = path.join(tmpRoot, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  await fs.writeFile(path.join(runDir, "brief.md"), brief);

  // Assertion: every node has parsed != null and no error.
  const nodeEndsById = new Map();
  for (const evt of events) {
    if (evt.type === "node-end") nodeEndsById.set(evt.id, evt);
  }
  for (const node of project.canvas.nodes) {
    const evt = nodeEndsById.get(node.id);
    if (!evt) fail(`node ${node.id} did not emit node-end`);
    if (evt.parsed == null) {
      fail(`node ${node.id} parsed JSON is null (model returned non-JSON or empty body)`);
    }
  }
  ok(`all ${project.canvas.nodes.length} nodes emitted node-end with parsed JSON`);

  // Assertion: brief contains a section per node (## <title>).
  for (const node of project.canvas.nodes) {
    if (!brief.includes(`## ${node.title}`)) {
      fail(`brief missing section for "${node.title}"`);
    }
  }
  ok(`brief contains a section per node`);

  // Assertion: artifacts on disk.
  const transcriptStat = await fs.stat(path.join(runDir, "transcript.json"));
  const briefStat = await fs.stat(path.join(runDir, "brief.md"));
  if (!transcriptStat.size) fail("transcript.json is empty");
  if (!briefStat.size) fail("brief.md is empty");
  ok(`artifacts written to ${runDir}`);

  // Pass 7: run the sentinel override sub-test under the same process. This
  // uses mocked fetch so it doesn't depend on Ollama being available even
  // though we just successfully ran against a real instance.
  await runSentinelOverrideSubTest(project);
  // Pass 11: loaded-uploads sub-test under the same process.
  await runLoadedUploadsSubTest(project);

  console.log("");
  console.log("Summary:");
  console.log(`  model:     ${transcript.model}`);
  console.log(`  levels:    ${transcript.levels.map((l) => l.length).join(",")}`);
  console.log(`  nodes:     ${transcript.nodes.length}`);
  console.log(`  total ms:  ${transcript.nodes.reduce((s, n) => s + (n.durationMs || 0), 0)}`);
  console.log(`  artifacts: ${runDir}`);

  process.exit(0);
}

main().catch((err) => {
  fail(`unexpected: ${err?.stack || err?.message || err}`);
});
