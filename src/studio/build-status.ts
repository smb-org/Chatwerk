interface OverlayClientBuild {
  client: string;
  buildId?: unknown;
}

const outputClients = new Set(["browser", "obs", "widget"]);

export function countOutdatedOutputs(clients: readonly OverlayClientBuild[], studioBuildId: string): number {
  return clients.reduce((count, client) =>
    count + Number(outputClients.has(client.client) && client.buildId !== studioBuildId), 0);
}
