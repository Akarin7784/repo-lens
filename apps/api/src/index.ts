import { buildApp } from './app.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = buildApp();
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
