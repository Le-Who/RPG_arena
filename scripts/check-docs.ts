import { checkDocumentation } from "./lib/check-docs";

checkDocumentation(process.cwd()).then(result => {
  if (result.errors.length) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Documentation: ${result.filesChecked} files, ${result.linksChecked} local links, current npm commands and migration ledger checked. External URLs and anchors are not checked.`);
  }
}).catch(error => {
  console.error(`Documentation check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
