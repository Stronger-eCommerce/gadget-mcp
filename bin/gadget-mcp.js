#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "setup") {
  import("../dist/setup.js").then(({ runSetup }) => runSetup()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  import("../dist/index.js").catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
