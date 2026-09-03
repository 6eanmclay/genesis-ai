// A child process for verify-exit-code-integrity.ts. Not a suite: it lives in
// scripts/lib/ so suite discovery never picks it up.
//
// Each mode reproduces one way a suite can end, against the imports that carry
// the exit hook. What it prints does not matter; the exit code is the whole
// observation.
const mode = process.argv[2];

async function main(): Promise<void> {
  switch (mode) {
    case "realpg-fail":
      await import("./realPostgres");
      process.exitCode = 1;
      return;
    case "testserver-fail":
      await import("./testServer");
      process.exitCode = 1;
      return;
    case "realpg-pass":
      await import("./realPostgres");
      return;
    case "realpg-explicit":
      await import("./realPostgres");
      process.exit(3);
    case "realpg-throw":
      await import("./realPostgres");
      throw new Error("deliberate");
    case "bare-fail":
      process.exitCode = 1;
      return;
    default:
      console.error(`unknown mode ${JSON.stringify(mode)}`);
      process.exit(64);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
