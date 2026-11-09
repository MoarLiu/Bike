const { app } = require('electron');
const path = require('node:path');
const run = async () => {
  await app.whenReady();
  app.dock?.hide();
  const { createLiveWorkspaceStore } = await import('../mcp/bike-live.mjs');
  const { createBikeMcpServer } = await import('../mcp/bike-server.mjs');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const discoveryPath = process.env.BIKE_LIVE_DISCOVERY ?? path.join(app.getVersion().includes('-') ? path.join(app.getPath('appData'), 'Bike-2-preview') : app.getPath('userData'), 'live-mcp.json');
  const store = await createLiveWorkspaceStore({ discoveryPath, clientName: 'Bike bundled MCP stdio' });
  const server = await createBikeMcpServer({ store, version: app.getVersion() });
  const finish = () => { store.close(); app.exit(0); };
  process.stdin.once('end', finish);
  process.once('SIGTERM', finish);
  process.once('SIGINT', finish);
  await server.connect(new StdioServerTransport());
};
run().catch((error) => { process.stderr.write(`Bike Live MCP 启动失败 ${error.message}\n`); app.exit(1); });
