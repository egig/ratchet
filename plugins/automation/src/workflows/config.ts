export interface WorkflowConfig {
  adapter: 'inngest';
  appId: string;
  /** Omit to use INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY. Never expose to the browser. */
  eventKey?: string;
  signingKey?: string;
  /** Override when moving to self-hosted Inngest. */
  baseUrl?: string;
  isDev?: boolean;
  limits?: { items?: number; concurrency?: number; chainDepth?: number };
}
