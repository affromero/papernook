import {
  AccessService,
  executeAccessCommand,
  parseAccessCommand,
  readLocalSetupInput,
  readLocalResetInput,
} from "thesidedoor-core/access";
import { PapernookIdentityStore } from "../../src/lib/auth/identity-store";
import { dataRoot } from "../../src/lib/data-dir";
import { accessOrigins } from "../../src/lib/auth/platform/configuration";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "validate-config") {
    accessOrigins();
    process.stdout.write("Access origin configuration is valid.\n");
    return;
  }
  parseAccessCommand(args);
  if (args[0] === "initialize") accessOrigins();
  const identity = new PapernookIdentityStore(dataRoot());
  const access = new AccessService({ store: identity.accessStore() });
  const output = await executeAccessCommand(access, args, {
    setupInput: readLocalSetupInput,
    resetInput: readLocalResetInput,
    initialize: async () => {
      await identity.initializeCanonical();
      return { warnings: [] };
    },
  });
  process.stdout.write(output + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Access command failed: ${error instanceof Error ? error.message : "Unknown failure"}\n`,
  );
  process.exitCode = 1;
});
