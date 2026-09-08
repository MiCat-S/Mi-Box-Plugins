import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin} from "telebox/sdk";

/**
 * System command execution is owned by the Core V2 `exec` builtin. Keeping an
 * empty package definition lets the repository retain the historical plugin
 * identity without registering a second command or executing outside Core's
 * privilege and process-budget policy.
 */
export default function createExecCompatibility() {
  return definePlugin({renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "exec",
    description: "系统命令执行由 Core V2 内置 exec 提供",
    commands: {},
  });
}
