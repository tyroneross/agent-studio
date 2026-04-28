# agent-studio

A local visual canvas for designing and testing small agent graphs against your own Ollama instance. No cloud, no waiting, no signup.

## At a glance

```
  +-----------+      +-----------+      +-----------+      +-----------+
  |  Intake   |----->|  Policy   |----->| Orches-   |----->| Executor  |
  |  (agent)  |      |  gate     |      | trator    |      | (tool)    |
  +-----------+      +-----------+      +-----------+      +-----------+
                                              |                  |
                                              v                  v
                                        +-----------------------------+
                                        |        Eval check           |
                                        +-----------------------------+

         <-------------------- canvas --------------------><- test panel ->
```

The canvas is on the left. The right side panel edits the selected node. The test panel slides up from the bottom and runs the graph against a model you pick.

## Prerequisites

- **Node 20+**
- **Ollama** running locally (default `http://localhost:11434`) with at least one chat model pulled. For example:
  ```
  ollama pull gpt-oss:20b
  ```
  Any chat-capable model works. The app will list every model your Ollama returns.

## Quick start

```
git clone https://github.com/tyroneross/agent-studio.git
cd agent-studio
npm install
npm run dev
```

Open http://localhost:3030. You will see either the empty-state landing page (first run) or the project list.

## First-time walkthrough

1. **Try the demo project.** On the landing page, click *Try the demo project*. It creates a project called *Demo: Solo Tool Agent* with a working folder at `/tmp/agent-studio-demo/`, pre-fills goal/context/outcome, seeds a 5-node graph, and routes you to the canvas.
2. **Read the welcome modal.** A short modal explains the three core gestures: drag to move a node, drag from a port to connect, click to edit on the right.
3. **Pick a model.** Click the test panel handle at the bottom of the canvas. Pick a model from the dropdown. If the dropdown says *ollama unreachable*, jump to *Troubleshooting*.
4. **Run a test query.** Type a query (the panel suggests `What's the riskiest dependency in this graph?`). Click *Run*. Watch the per-node status fill in.
5. **Inspect the output.** When the run completes, the brief shows below. Click *Open run folder* to see the path to `transcript.json` and `brief.md` on disk.
6. **Edit and rerun.** Click any node, change its instructions in the right panel, and run again. The canvas auto-saves to localStorage.

## Working folder

Every project has a *working folder* — an absolute path under `/Users/`, `/tmp/`, or `/var/folders/`. The runtime writes each test run to `<workingFolder>/runs/<timestamp>/` containing:

- `transcript.json` — every node's input, output, and timing.
- `brief.md` — a human-readable summary.

Uploads dropped on the new-project form land in `<workingFolder>/uploads/`. The path allowlist exists so the app never writes outside paths a single-user dev tool should touch.

## Troubleshooting

- **Ollama unreachable.** Run `ollama serve` in a separate terminal, or set `OLLAMA_BASE_URL` if it lives somewhere other than `http://localhost:11434`. Confirm `curl http://localhost:11434/api/tags` returns JSON before retrying.
- **No models pulled.** The model dropdown will say *no models pulled*. Run `ollama pull gpt-oss:20b` (or any other chat model) and refresh.
- **Port 3030 busy.** Either stop whatever is on 3030, or run `PORT=3031 npm run dev` and update the URL accordingly. The dev server is pinned to 3030 by default in `package.json`.
- **Working folder rejected.** Paths must start with `/Users/`, `/tmp/`, or `/var/folders/`. Pick a different folder or create one under `/tmp/`. The app calls `/api/fs/validate` to check; the response includes a reason.
- **Demo project conflict.** Clicking *Try the demo project* a second time opens the existing one rather than duplicating. To start fresh, delete it from the project list first.

## Architecture overview

A Next.js 16 + React 19 app that stores all project state in `localStorage` (no database). The canvas page renders an SVG layer for edges and absolutely positioned divs for nodes. Test runs go through `/api/agent/run`, which runs the graph as a DAG against your local Ollama and streams Server-Sent Events for live per-node status. Artifacts get written to the project's working folder under `runs/<timestamp>/`.

## Repository

[github.com/tyroneross/agent-studio](https://github.com/tyroneross/agent-studio)

## License

MIT. See [LICENSE](./LICENSE).
