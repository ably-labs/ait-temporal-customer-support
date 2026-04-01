import { config } from 'dotenv';
config({ path: '.env.local' });

import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { closeRealtimeClient, closeAllSessionClients } from './ably-clients';

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: 'support-copilot',
    workflowsPath: require.resolve('./workflows'),
    activities,
  });

  console.log('Temporal worker started, listening on task queue: support-copilot');

  const shutdown = () => {
    closeAllSessionClients();
    closeRealtimeClient();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
