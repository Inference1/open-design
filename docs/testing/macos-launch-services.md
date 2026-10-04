# macOS registration after payload activation

The packaged launcher refreshes the confirmed payload's application and URL
claims with LaunchServices after persisting its successful activation. It
registers the exact, canonical `.app` bundle with `lsregister -f`; it does not
recursively register Electron helper apps. Registration has a five-second
timeout, and a failure is logged without undoing successful activation.

This is one part of [#8547](https://github.com/nexu-io/open-design/issues/8547).
Registration alone does not establish which copy wins a bundle-id lookup when
older copies are still registered. Migration of real installed bundles, stable
launch aliases, Dock cleanup, and a launcher CLI are separate work.

## Automated coverage

`apps/packaged/tests/launcher-registration.test.ts` checks that registration
follows persistence of the successful runtime pointer and removal of the launch
attempt. Failed or skipped confirmations do not register a bundle, and a failed
registration does not reverse the successful pointer.

`apps/packaged/tests/mac-launch-services.test.ts` checks the exact application
path, alias resolution, platform gates, command arguments, timeout, and failure
handling with an injected command runner. These tests do not exercise the
macOS registration database.

## Native acceptance

Use the packaged macOS lifecycle harness described in
[`tools/pack/AGENTS.md`](../../tools/pack/AGENTS.md). Compare the same update
scenario on the base commit and this branch, using separate test namespaces.
Include an existing real installed bundle and a supported linked install shape
when available. Record the installed version, the running payload version, and
the namespace for each scenario.

1. Activate a newer payload and wait for its desktop to become ready. Confirm
   the successful launcher pointer names that payload and the attempt is gone.
2. Inspect registration after activation:

   ```sh
   /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump
   ```

   Check the registered payload bundle path, version, bundle identifier, and URL
   claims. The registrar should receive only the main `.app`.
3. Fully stop the app, launch through the installed entry, and check the actual
   running executable and version. Also check Spotlight and Launchpad. For a
   stable-channel install, `open -b io.open-design.desktop` is a useful diagnostic:
   record which copy it selects, especially when an older real bundle remains.
   A successful registration call is not proof that all these surfaces select
   the active payload.
4. Confirm that a failed registration leaves the app usable, the successful
   pointer intact, and a warning in the packaged desktop log. Existing real
   bundles and Dock preferences should retain their contents.

Rollback selection retains the launcher's existing confirmation policy. A
`last-successful` fallback is not a new confirmed activation in this patch, so
its registration behavior requires separate acceptance when rollback policy
changes.

Apple describes explicit re-registration after changes to an application's
LaunchServices information in its
[Launch Services guide](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/LaunchServicesConcepts/LSCConcepts/LSCConcepts.html).
