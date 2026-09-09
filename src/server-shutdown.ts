export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
): Promise<void> {
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  // Observe both outcomes immediately: sequential awaits can leave an early
  // HTTP rejection unhandled or skip drainage when application cleanup fails.
  const results = await Promise.allSettled([
    httpClosed,
    Promise.resolve().then(closeApplication),
  ]);
  throwShutdownErrors(results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
}

export async function closeResourcesInOrder(
  steps: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { errors.push(error); }
  }
  throwShutdownErrors(errors);
}

function throwShutdownErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Multiple errors while shutting down DevSpace.");
}
