# Compounding MCP

A model-agnostic MCP server for persistent agent contributions and numerical experiments. It uses Boruna workflows for capability-gated checks and evidence bundles; Node.js provides the MCP transport and Git-history inspection.

> **Experimental proof of concept.** A workflow operation is validated by a Boruna `.ax` step. The wrapper then records JSON state under `.boruna/swarm/<id>/`. Version 0.1 supports one active server process per working directory and does not create or merge Git commits.

## Requirements

- Node.js 20+
- Boruna 4.2+
- Git repository as working directory

## Install from a GitHub release

Download the `compounding-mcp-0.1.0.tgz` release asset, then run:

```sh
npm install --global ./compounding-mcp-0.1.0.tgz
```

Set up any MCP client with:

```json
{
  "mcpServers": {
    "compounding": {
      "command": "compounding-mcp",
      "env": { "COMPOUNDING_WORKDIR": "/path/to/repository" }
    }
  }
}
```

If Boruna is not on `PATH`, set `BORUNA_BIN` to its executable path.

## Tools

- `swarm_init`: create a task spec and episode budget.
- `swarm_status`: read budget, workers, contributions, nominations, and best score.
- `swarm_announce`: publish worker scope, deliverable, success condition, and abort condition.
- `swarm_commit`: validate provenance fields with Boruna, then record the contribution, score, and validation note.
- `swarm_nominate`: record a candidate vote and rationale.
- `swarm_abstain`: record why a worker has no useful work; does not consume budget.
- `swarm_ancestry`: trace Git parent ancestry for a candidate SHA (requires a committed candidate in the selected repository).

All records live in `.boruna/swarm/<swarm_id>/`. The Boruna policy grants only `fs.read` and `fs.write` within `.boruna/swarm`.

## Limitations

- The MCP server is model-agnostic, but each client must launch it through its MCP configuration.
- `swarm_commit` stores provenance metadata; it does not apply candidate code or create a Git commit.
- The server trusts caller-supplied benchmark scores and validation descriptions. It does not run the numeric benchmark.
- `informed_by` validation checks SHA syntax and requires the physical parent to appear in the list. Full cross-branch graph analysis is planned.
- Keep only one active server process per working directory. The Boruna workflow interface has fixed staged input paths.
- Nomination counts are coordination metadata, not correctness evidence.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Check Boruna assets with:

```sh
for d in workflows/swarm_*; do boruna workflow validate "$d"; done
find workflows -name '*.ax' -print0 | xargs -0 -n1 boruna lang check --json
```

## Release

Push a version tag such as `v0.1.0`. GitHub Actions runs tests, validates workflows, builds the npm tarball, and attaches it to a GitHub Release. No GitHub login is needed by end users to download a public release.
