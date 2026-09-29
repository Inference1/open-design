import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const rollbackWorkflow = new URL("../../../.github/workflows/release-rollback.yml", import.meta.url);
const stableWorkflow = new URL("../../../.github/workflows/release-stable.yml", import.meta.url);

function section(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

describe("release rollback workflow", () => {
  it("[P0] queues against a real stable publish instead of racing it", async () => {
    const [rollback, stable] = await Promise.all([
      readFile(rollbackWorkflow, "utf8"),
      readFile(stableWorkflow, "utf8"),
    ]);

    // release-stable derives its group from the release mode, so a real publish
    // run lands in `...-publish`. Rollback joins that exact group on purpose: a
    // rollback that overlapped a publish would leave `stable/latest` mixing two
    // releases. If the template below changes, this pairing must be rechecked.
    expect(stable).toContain("group: open-design-release-stable-${{ inputs.dry_run }}");
    expect(rollback).toContain("group: open-design-release-stable-publish");
    expect(rollback).toContain("cancel-in-progress: false");
  });

  it("[P0] rejects a malformed request before any credential is in scope", async () => {
    const rollback = await readFile(rollbackWorkflow, "utf8");
    const guard = section(rollback, "  guard:", "  rollback:");

    expect(guard).not.toContain("secrets.");
    // Each condition must exit 1. An `if:` would skip the job green, and a
    // rollback that quietly did nothing is the worst possible outcome during
    // an incident — it reads as "handled".
    expect(guard).toContain("exit 1");
    expect(guard).toContain("refs/heads/main");
    expect(guard).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  it("[P0] routes the write through the release CLI, not ad-hoc shell", async () => {
    const rollback = await readFile(rollbackWorkflow, "utf8");

    expect(rollback).toContain("run: pnpm exec tools-release rollback-latest");
    expect(rollback).toContain("RELEASE_ROLLBACK_FROM_VERSION: ${{ inputs.from_version }}");
    expect(rollback).toContain("RELEASE_ROLLBACK_TO_VERSION: ${{ inputs.to_version }}");
    expect(rollback).toContain("RELEASE_CHANNEL: stable");
    // No aws/rclone/curl PUT path may grow beside the CLI: the refusals that
    // make a rollback safe all live in rollback-latest.ts.
    expect(rollback).not.toMatch(/aws s3|rclone|curl .*-X PUT/);
  });

  it("[P0] proves the restored tag has a release before it writes anything", async () => {
    const rollback = await readFile(rollbackWorkflow, "utf8");

    // The badge move runs after the R2 write. Discovering a missing release
    // there would end the run with `stable/latest` already moved and the
    // GitHub "Latest" badge still on the retracted version.
    const assertIndex = rollback.indexOf("- name: Assert the restored version has a GitHub Release");
    const writeIndex = rollback.indexOf("- name: Roll back stable latest");
    expect(assertIndex).toBeGreaterThanOrEqual(0);
    expect(assertIndex).toBeLessThan(writeIndex);
  });

  it("[P0] moves only the GitHub Release badge and never rewrites release copy", async () => {
    const rollback = await readFile(rollbackWorkflow, "utf8");
    const step = section(rollback, "      - name: Move the GitHub Release latest badge", "      - name: Publish the run summary");

    expect(step).toContain("if: ${{ !inputs.dry_run && inputs.move_github_release }}");
    expect(step).toContain("gh release edit \"$TO_TAG\" --latest");
    expect(step).not.toContain("--notes");
    expect(step).not.toContain("gh release delete");
  });

  it("[P1] tells the operator what a rollback does not reach", async () => {
    const rollback = await readFile(rollbackWorkflow, "utf8");
    const summary = section(rollback, "      - name: Publish the run summary", "      - name: Upload rollback outputs");

    // A rollback stops the rollout; it does not recall installs that already
    // updated, and it leaves three other surfaces advertising the retracted
    // version. Losing any of these from the summary means an operator reads a
    // green run as "done".
    expect(summary).toContain("Download page");
    expect(summary).toContain("What's New");
    expect(summary).toContain("roll-forward patch");
  });
});
