import { App } from '@slack/bolt';
/** Minimal logger interface compatible with both pino.Logger and FastifyBaseLogger */
interface MinimalLogger {
  info(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

/**
 * SlackService — wraps the @slack/bolt App with lifecycle management.
 *
 * Design:
 * - If SLACK_BOT_TOKEN or SLACK_APP_TOKEN is absent, start() is a no-op.
 *   The service never throws on missing tokens; it simply remains disabled.
 * - started flag prevents calling app.stop() on an uninitialized App.
 * - getApp() returns the Bolt App instance for downstream handler registration
 *   (Phase 25 slash commands, Phase 26 notifications).
 * - isEnabled() is the safe feature-flag check for callers.
 */
export class SlackService {
  private app: App | null = null;
  private started = false;

  constructor(
    private readonly botToken: string | undefined,
    private readonly appToken: string | undefined,
    private readonly logger: MinimalLogger
  ) {}

  async start(): Promise<void> {
    if (!this.botToken || !this.appToken) {
      this.logger.info('Slack tokens not configured — Slack integration disabled');
      return;
    }

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    await this.app.start();
    this.started = true;
    this.logger.info('Slack app connected via Socket Mode');
  }

  async stop(): Promise<void> {
    if (!this.app || !this.started) return;
    await this.app.stop();
    this.started = false;
    this.logger.info('Slack app disconnected');
  }

  isEnabled(): boolean {
    return this.app !== null && this.started;
  }

  getApp(): App | null {
    return this.app;
  }
}
