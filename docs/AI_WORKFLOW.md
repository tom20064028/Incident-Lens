# AI-assisted workflow

> Draft written from the build session. Edit it in your own words before submitting.

## Tools

- **ChatGPT**: scoping. It turned the take-home brief into a concrete project spec (stack, pipeline, test list, "no LLM yet").
- **Claude Code (desktop app, Claude Opus)**: reviewed that spec against the submission requirements, then implemented, tested and verified the project. Verification covered the terminal, the built-in browser, and Docker.

## Key steps

1. **Spec review before coding.** I asked Claude Code to check whether the ChatGPT spec suited the test before building anything. It kept the scope but closed some gaps:
   - The spec had no AI-workflow write-up or architecture diagram, both required by the submission, so those were added.
   - "Plausible service relationship" was too vague, so it became "one service's message names the other".
   - Heuristic weights became explicit, and the threshold was set so time proximity alone can never link two events.
   - An incident was defined as a correlated group containing at least one ERROR or FATAL event.
   - An "Analyze sample logs" button was added so reviewers can see it working in one click.
   - The deployment is one Docker image, with Fastify serving the UI.
2. **Pipeline first, UI second.** Parsing, normalization and correlation were built as pure functions behind `analyze()`. The API and UI are thin layers on top.
3. **Sample data designed as test fixtures.** Four services in mixed formats, covering four scenarios:
   - an exact trace-ID chain;
   - a heuristic chain where inventory-service logs have no IDs;
   - unrelated WARNs placed close in time to an incident, to tempt false grouping;
   - one isolated error.
4. **Tests, then reading the output.** 53 Vitest tests, plus a manual review of the generated incidents: confidences, reasons, and which events were left out.

## How the result was checked

- **The tests found real problems.** The first run had 2 failures:
  - **A real parser bug:** in ECS-style logs `"service": {"name": ...}` is an object, and the parser took it as the service name (`[object Object]`). Fixed by accepting only primitive values for alias fields.
  - **A wrong test:** a hand-computed epoch constant was incorrect. Replaced with `Date.UTC(...)`.
- **The typecheck caught Fastify 5's `unknown` error type.**
- **The scenario output was read by eye**, not only asserted:
  - The heuristic incident's weakest link (0.56) is the DB-timeout match: same error code and a shared keyword, 1 s apart.
  - Narrowing the window to 2 s splits that event into its own incident, which shows the setting has a real effect.
- **Independent AI code review.** A separate subagent reviewed the code read-only and reproduced each finding before reporting it. It found 3 critical issues:
  1. O(n²) heuristic pairing: 4,000 same-time errors in a ~300 KB file crashed Node with out-of-memory.
  2. Nanosecond epoch timestamps crashed the request.
  3. Regex time grew quadratically on very long lines.

  It also found 3 major issues: unknown text levels silently dropped, placeholder trace IDs merging unrelated events, and heuristic links chaining without limit.
  - **Fixed:** all critical issues, the first two majors, and the cheap minors, each with a regression test (69 tests total).
  - **Documented, not fixed:** transitive chaining, which needs a design decision rather than a quick patch.
- **UI checked in a browser** with the sample scenario, including the expandable reasons on heuristic links.
- **Docker image built and run:** the health check, sample analysis and static UI were checked inside the container. The build stage also runs the tests.

## Time spent

- About X min reviewing the spec and making scoping decisions.
- About 20 min of AI-driven implementation and verification.
- About X min of my own review.

*(Fill in your actual numbers.)*

## What I would do next

- Clock-skew tolerance per service, and a dependency map supplied by the user (stronger than name mentions).
- Streaming parse for large files.
- LLM-assisted summaries layered **on top of** the deterministic incidents, with the evidence (event IDs) cited.
