#!/usr/bin/env node
const cmd = process.argv[2];

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  import("../dist/setup.js").then(({ runVersion }) => runVersion()).catch(die);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  import("../dist/setup.js").then(({ runHelp }) => runHelp()).catch(die);
} else if (cmd === "setup") {
  import("../dist/setup.js").then(({ runSetup }) => runSetup()).catch(die);
} else if (cmd === "verify") {
  import("../dist/setup.js").then(({ runVerify }) => runVerify()).catch(die);
} else if (cmd === "list") {
  import("../dist/setup.js").then(({ runList }) => runList()).catch(die);
} else if (cmd === "uninstall") {
  import("../dist/setup.js").then(({ runUninstall }) => runUninstall()).catch(die);
} else {
  // No command = start MCP server
  import("../dist/index.js").catch(die);
}

function die(err) {
  console.error(err);
  process.exit(1);
}
