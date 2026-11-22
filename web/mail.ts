// Account emails and gate alerts, sent through the outbox (src/email.ts).
import * as dk from '../index.ts';
import type { ContextModule } from './context.ts';
import { logger, logMessages } from '../src/logging.ts';

export function createMail(deps: ContextModule) {
  const { APP, config, mailer, siteNameOf, store } = deps;
  let sending: Promise<unknown> | null = null;
  function sendEmails(): void {
    if (!mailer || sending) return;
    sending = dk.sendQueued(store, mailer, config.email.from, logMessages('email'))
      .catch((err) => logger('email').error`Outbox failed: ${(err as Error).message}`)
      .finally(() => { sending = null; });
  }
  // Queues a message to an address (nothing when email is off). A failure to queue is written to the server log.
  async function mailTo(to: string, msg: { subject: string; text: string }, kind: string): Promise<void> {
    await mailOrFail(to, msg, kind).catch(() => {});
  }
  // The same, but a failure to queue is also thrown (502): for links the user is told were sent (invitations, email
  // confirmations).
  async function mailOrFail(to: string, msg: { subject: string; text: string }, kind: string): Promise<void> {
    if (!mailer || !to) return;
    try { await dk.queueEmail(store, { to, ...msg, kind }); sendEmails(); } catch (err) {
      const why = (err as Error).message;
      logger('email').warn`Not queued (${kind}): ${why}`;
      throw dk.httpError(`The email couldn't be sent (${why}). Try again later.`, 502);
    }
  }
  // A security alert to the user's confirmed email (always sent; it can't be turned off).
  async function securityAlert(username: string, what: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (user && user.email) await mailTo(user.email, dk.messages.security(APP, user.username, what), 'security');
  }
  // A gate-access email to the user (only to a confirmed email, and only if they haven't turned these off).
  async function accessEmail(username: string, msg: (user: dk.User) => { subject: string; text: string }): Promise<void> {
    const user = await dk.getUser(store, username);
    if (user && user.email && user.notifyAccess) await mailTo(user.email, msg(user), 'access');
  }
  const gateName = async (phone: string) => (await siteNameOf(phone)) || `the gate ${phone}`;
  // A gate alert to the gate's admins who have alerts on.
  async function gateAlert(phone: string, what: string, detail: string): Promise<void> {
    if (!mailer) return;
    const name = await gateName(phone);
    for (const recipient of await dk.alertRecipients(store, phone)) await mailTo(recipient.email, dk.messages.gateAlert(APP, recipient.username, name, what, detail), 'alert');
  }
  // Sends a new invitation link to the invited user's email (from `by`, for gate `phone`).
  async function sendInvite(username: string, by: string, phone: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (!user || !user.pendingEmail) return;
    const token = await dk.createToken(store, 'invite', user.username, user.pendingEmail);
    await mailOrFail(user.pendingEmail, dk.messages.invite(APP, user.username, by, await gateName(phone), token), 'invite');
  }
  // Sends the confirmation link for the user's pending email.
  async function sendVerification(username: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (!user || !user.pendingEmail || !mailer) return;
    await mailOrFail(user.pendingEmail, dk.messages.verify(APP, user.username, await dk.createToken(store, 'verify', user.username, user.pendingEmail)), 'verify');
  }
  // Resolves when no email is being sent (waited for on shutdown, so an email the mail server took is marked sent).
  const mailIdle = () => sending ?? Promise.resolve();
  return { mailIdle, sendEmails, mailTo, securityAlert, accessEmail, gateName, gateAlert, sendInvite, sendVerification };
}

export type MailModule = ReturnType<typeof createMail>;
