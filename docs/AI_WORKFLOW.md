# AI-assisted workflow

## Tools used

- **ChatGPT** — requirement analysis, project exploration, technical design, and reviewing design/UX decisions.
- **Claude Code (Claude Opus)** — implementation, testing, browser/Docker verification, and code review.
- **Claude Code subagent** — separate read-only review of the first working implementation.

I also used the tools to check each other's output. ChatGPT's initial specification was reviewed by Claude before implementation; Claude's implementation and review findings were brought back to ChatGPT for further design review; later UX changes proposed during that review were implemented and verified again with Claude.

## Workflow

### 1. Understand the assignment and choose a project

I first used ChatGPT to review the take-home requirements and explore several manageable project ideas.

I compared them based on scope, technical depth, ease of demonstration, and how much engineering judgement they would allow me to show.

I chose a multi-service log incident analyzer because it was small enough for the assignment while still involving parsing, normalization, event correlation, false-positive trade-offs, testing, and deployment.

### 2. Design before coding

I used ChatGPT to turn the idea into a technical specification covering:

- Node.js and TypeScript;
- a small React UI;
- multi-file uploads;
- NDJSON and conventional text logs;
- normalization into a common event model;
- exact correlation using `traceId` and `requestId`;
- heuristic correlation when IDs are unavailable;
- explicit evidence and scores for heuristic links;
- Docker deployment;
- automated tests.

I reviewed and refined the design before handing it to Claude Code.

### 3. Challenge the design

One question I raised was:

> What does this tool provide that I would not get by simply uploading the logs to an LLM and asking it to analyse them?

That led to the main design principle:

> Structure and correlate the evidence deterministically first. Any future AI interpretation should operate on top of that evidence.

I therefore decided that:

- exact trace/request IDs take priority over heuristics;
- heuristic links must expose supporting evidence;
- time proximity alone must never create a link;
- inferred relationships must be labelled as heuristic;
- runtime LLM analysis was not necessary for the first version.

I initially considered an LLM-generated diagnosis layer, but rejected it for this submission because it increased scope without strengthening the main engineering demonstration.

### 4. Implement with Claude Code

Once the design was stable, I passed the specification to Claude Code and first asked it to review the spec against the assignment requirements.

I accepted several refinements, including:

- an architecture diagram and AI-workflow document;
- a concrete incident definition: a correlated group containing at least one `ERROR` or `FATAL`;
- explicit heuristic weights;
- using one Docker image for the Fastify API and React UI;
- bundled sample logs for immediate demonstration.

Claude then implemented the parser, normalization pipeline, correlation engine, API, UI, tests, and Docker setup.

### 5. Test and inspect the first implementation

I did not treat generated code as complete simply because it compiled.

Testing exposed issues including:

- an ECS-style `service: { name: ... }` object being used directly as the service value, resulting in `[object Object]`;
- an incorrectly hand-calculated epoch timestamp in a test;
- a Fastify type-checking issue.

I also inspected the actual incidents, scores and evidence rather than relying only on automated assertions.

### 6. Run a separate code-review pass

I asked a separate Claude subagent to review the first working implementation without modifying it first.

It identified several failure modes, including:

- heuristic pair comparisons becoming too expensive with thousands of simultaneous errors;
- nanosecond epoch timestamps causing failures;
- expensive regex processing on very long lines;
- placeholder trace IDs joining unrelated events;
- missing severity aliases;
- transitive heuristic chaining.

I delegated the initial triage and fixes, then reviewed the resulting changes and the decision to leave transitive chaining documented rather than adding an arbitrary rule.

The bounded-processing changes included:

- limiting each event to a fixed number of nearby comparison candidates;
- limiting uploads and total event count;
- truncating unusually long text lines before parsing;
- limiting the amount of message text used for heuristic feature extraction.

These controls trade some theoretical recall and input flexibility for predictable runtime and memory usage.

### 7. Check the written design against the running system

I later asked Claude to compare the written design principles with the actual running behaviour.

This exposed an important mismatch.

I had stated that:

> Time proximity alone should never be enough to correlate two events.

However, the first implementation only guaranteed that at the default score threshold of `0.5`. Lowering the threshold in the UI could cause unrelated events to be linked purely because they happened close together.

I changed the implementation so that every heuristic link must first share at least one substantive evidence signal:

- endpoint/path;
- error code; or
- meaningful keywords.

Timing, severity and service-name mentions can increase the score, but cannot create a link by themselves.

Regression tests now check this rule at several thresholds, including `0`.

### 8. Review the interaction model

During UI review I also found that uploaded files and bundled sample files followed two different workflows.

Uploaded files appeared as a current batch, while the sample action bypassed that state and directly returned results.

I simplified this into one model:

> One analysis operates on one current batch of files.

Sample logs are now loaded into the same file list as normal uploads and go through the same analysis API.

Changing the current file batch clears the previous result, and **Clear files** resets the workspace.

Tuning controls are hidden under **Advanced settings** because they are useful for inspecting the algorithm but are not part of the normal workflow.

I also renamed **Minimum heuristic confidence** to **Minimum heuristic score**, and incident badges now display values such as `min score 0.56` instead of `56%`.

This reflects an important distinction: the score is a hand-tuned evidence score, not a calibrated probability.

## Key trade-offs

### False positives vs. false negatives

The heuristic correlation is intentionally conservative.

Incorrectly merging unrelated failures is more misleading than occasionally leaving a weakly related event uncorrelated.

### Explainability vs. flexibility

The heuristic weights are hand-picked prototype values.

A score such as `0.56` does not mean a 56% probability that two events belong to the same incident. It is only a relative evidence score used to filter inferred relationships.

In a production system I would calibrate the weights against labelled historical incidents.

### Correlation recall vs. processing cost

A fully pairwise comparison can grow quadratically with the number of candidate events.

The implementation bounds comparisons and input processing so runtime remains predictable. This can potentially miss relationships in extremely dense log streams, but avoids unbounded resource usage in the take-home implementation.

### Simplicity vs. production completeness

The application processes uploaded files in memory and does not persist incidents.

A production version would likely add persistent history, streaming ingestion, service topology information, and clock-skew handling.

## Verification

The project was checked using:

- automated tests for parsing, normalization, exact and heuristic correlation, API behaviour, workspace state, and regression cases;
- tests confirming that time-only events cannot link even at low heuristic-score thresholds;
- manual inspection of incident timelines, scores, and evidence;
- browser verification of sample loading, analysis, file removal, and workspace reset;
- API upload testing;
- Docker build and runtime verification;
- a separate AI-assisted code-review pass followed by regression tests.

The current test suite contains **84 automated tests**.

## Time spent

Approximately:

- **30 minutes** understanding the requirements and comparing project directions;
- **30 minutes** designing and refining the technical approach;
- **25 minutes** for the initial Claude Code implementation to reach a working Docker build;
- **about 2 hours** reviewing the result, running AI-assisted code reviews, fixing issues, refining UX, and verifying the final behaviour.

Total working time was approximately **3.5 hours**.

## What I would do next

If continuing the project, I would investigate:

1. a more deliberate solution to transitive heuristic chaining;
2. service-specific clock-skew tolerance;
3. a configurable service dependency map;
4. streaming parsing for larger log volumes;
5. LLM-assisted incident summaries and investigation suggestions layered on top of the deterministic evidence, with supporting event IDs cited in generated conclusions.