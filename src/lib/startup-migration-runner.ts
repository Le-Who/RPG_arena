/** Shared per-instance startup gate. A failed migration must never resolve as ready. */
export function createStartupMigrationRunner(migrate: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= Promise.resolve().then(migrate).catch(() => {
      pending = undefined;
      // Driver errors may include connection details; the operator can use the migration CLI.
      throw new Error("STARTUP_MIGRATION_FAILED");
    });
    return pending;
  };
}
