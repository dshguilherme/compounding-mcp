# Tiny CG experiment

This is a small CPU-only conjugate-gradient experiment with a known exact solution. It exercises the MCP's contribution tracking, validation note, score comparison, nomination, abstention, and Git-parent ancestry. It does **not** use a GPU; the purpose is to test the workflow end to end with cheap, deterministic arithmetic.

From a clean Git repository:

```sh
python -m unittest discover -s examples/tiny-cg -v
python examples/tiny-cg/cg_demo.py
```

Expected: the solver returns `x = [1, 2, 3]` within floating-point tolerance and the unit tests pass.

Then initialize the MCP server in this repository and use these tool calls:

1. `swarm_init` with `swarm_id="tiny-cg"`, task `Improve conjugate gradient convergence`, budget `5`, metric `residual_l2`, direction `minimize`.
2. `swarm_status` for `tiny-cg`.
3. `swarm_announce` worker `baseline`, gap `No verified baseline result`, deliverable `Run exact-solution test`, success `residual < 1e-12`, abort `baseline already recorded`.
4. Run the tests above. If they pass, record the current Git commit SHA from `git rev-parse HEAD`.
5. `swarm_commit` with that SHA as `parent` and in `informed_by`; use score `0.0` only for exact solution error or use the measured residual from output. Put the test command and result in `validation`.
6. `swarm_nominate` the same commit with a rationale tied to measured output.
7. `swarm_abstain` worker `duplicate-check` with a reason such as `No independent improvement candidate exists in this smoke test`.
8. `swarm_status` again and confirm budget, contribution, nomination, and best score persisted.
9. `swarm_ancestry` for the committed SHA. This checks Git parents only; the prototype does not yet expand cross-branch `informed_by` edges.

The MCP records the score and validation claim; it does not independently run or verify the benchmark. The test is run separately, and its output is supplied as evidence by the caller.
