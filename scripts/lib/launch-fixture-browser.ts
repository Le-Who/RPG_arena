import type { Server } from "node:http";

/** Launch failures happen before each fixture's browser cleanup block is entered. */
export async function launchFixtureBrowser<T>(server: Server, launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}
