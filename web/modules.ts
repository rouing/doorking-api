// Builds the server's modules from its services, each given only what it uses (dependencies flow one way:
// context <- auth, mail, editing <- snapshots <- jobs <- routes).
import { createAuth } from './auth.ts';
import { createContext, type Services } from './context.ts';
import { createEditing } from './editing.ts';
import { createJobs } from './jobs.ts';
import { createMail } from './mail.ts';
import { createSnapshots } from './snapshots.ts';
import { accountRoutes } from './routes/account.ts';
import { authRoutes } from './routes/auth.ts';
import { camerasRoutes } from './routes/cameras.ts';
import { connectionsRoutes } from './routes/connections.ts';
import { docsRoutes } from './routes/docs.ts';
import { gatesRoutes } from './routes/gates.ts';
import { relaysRoutes } from './routes/relays.ts';
import { residentsRoutes } from './routes/residents.ts';
import { schedulesRoutes } from './routes/schedules.ts';
import { workingCopyRoutes } from './routes/working-copy.ts';
import type { Route } from './routing.ts';

export function createModules(services: Services) {
  const context = createContext(services);
  const auth = createAuth(context);
  const mail = createMail(context);
  const editing = createEditing(context);
  const snapshots = createSnapshots({ ...context, ...editing });
  const jobs = createJobs({ ...context, ...editing, ...mail, ...snapshots });
  return { ...context, ...auth, ...mail, ...editing, ...snapshots, ...jobs };
}

export type Modules = ReturnType<typeof createModules>;

// Every route, in matching order (the first match wins).
export function createRoutes(modules: Modules): Route[] {
  return [
    ...docsRoutes(modules),
    ...authRoutes(modules),
    ...accountRoutes(modules),
    ...gatesRoutes(modules),
    ...connectionsRoutes(modules),
    ...residentsRoutes(modules),
    ...workingCopyRoutes(modules),
    ...relaysRoutes(modules),
    ...schedulesRoutes(modules),
    ...camerasRoutes(modules),
  ];
}
