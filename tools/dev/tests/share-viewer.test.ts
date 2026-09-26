import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOLS_DEV_DEFAULT_SHARE_VIEWER_URL, resolveToolsDevShareViewerEnv } from "../src/share-viewer.js";

test("the default Viewer origin stays unset until the test domain is decided", () => {
  // Decision 67 #7 is BLOCKED on the test domain; an empty default means the
  // daemon shows "link unavailable" rather than a guessed host.
  assert.equal(TOOLS_DEV_DEFAULT_SHARE_VIEWER_URL, "");
  assert.deepEqual(resolveToolsDevShareViewerEnv({}), {});
});

test("injects the default Viewer origin when none is configured", () => {
  assert.deepEqual(
    resolveToolsDevShareViewerEnv({}, "https://viewer.example.test"),
    { OD_SHARE_VIEWER_URL: "https://viewer.example.test" },
  );
  assert.deepEqual(resolveToolsDevShareViewerEnv({ OD_SHARE_VIEWER_URL: "  " }, "https://viewer.example.test"), {
    OD_SHARE_VIEWER_URL: "https://viewer.example.test",
  });
});

test("an operator-provided Viewer configuration overrides the default", () => {
  assert.deepEqual(
    resolveToolsDevShareViewerEnv({ OD_SHARE_VIEWER_URL: "https://override.example.test" }, "https://viewer.example.test"),
    {},
  );
  assert.deepEqual(
    resolveToolsDevShareViewerEnv({ OD_SHARE_VIEWER_URLS: '{"local":"https://local.example.test"}' }, "https://viewer.example.test"),
    {},
  );
});
