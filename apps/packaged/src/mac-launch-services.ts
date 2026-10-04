import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LSREGISTER_PATH = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

type MacRegistrationExec = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: true },
) => Promise<unknown>;

export type MacApplicationRegistrationResult =
  | { status: "registered"; appBundlePath: string }
  | { status: "skipped" }
  | { status: "failed"; error: unknown };

/**
 * Refresh the confirmed payload's application and URL claims. This does not
 * select a preferred bundle, remove old registrations, or alter Dock entries.
 */
export async function refreshMacApplicationRegistration(input: {
  executablePath: string;
  platform?: NodeJS.Platform;
  exec?: MacRegistrationExec;
}): Promise<MacApplicationRegistrationResult> {
  if ((input.platform ?? process.platform) !== "darwin") return { status: "skipped" };
  if (!isAbsolute(input.executablePath)) return { status: "skipped" };
  const executableRoot = dirname(input.executablePath);
  const contentsRoot = dirname(executableRoot);
  const appBundleRoot = dirname(contentsRoot);
  if (
    basename(executableRoot) !== "MacOS" ||
    basename(contentsRoot) !== "Contents" ||
    !basename(appBundleRoot).endsWith(".app")
  ) return { status: "skipped" };

  try {
    const appBundlePath = await realpath(appBundleRoot);
    await (input.exec ?? execFileAsync)(LSREGISTER_PATH, ["-f", appBundlePath], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return { status: "registered", appBundlePath };
  } catch (error: unknown) {
    return { status: "failed", error };
  }
}
