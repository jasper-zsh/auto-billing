import { ImapClient } from './imap'

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
	//
	// Example binding to a D1 Database. Learn more at https://developers.cloudflare.com/workers/platform/bindings/#d1-database-bindings
	// DB: D1Database
	EMAIL: string;
	IMAP_HOST: string;
	IMAP_PORT: number;
	IMAP_SECURE: boolean;
	EMAIL_PASS: string;

	auto_billing: KVNamespace
}

const LAST_SEQ_KEY = 'lastSeq'

export default {
	// The scheduled handler is invoked at the interval set in our wrangler.toml's
	// [[triggers]] configuration.
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const imapClient = new ImapClient({
			host: env.IMAP_HOST,
			port: env.IMAP_PORT,
			tls: env.IMAP_SECURE,
			auth: {
				user: env.EMAIL,
				pass: env.EMAIL_PASS,
			},
		});
		await imapClient.connect();
		console.log('IMAP connected')
		await imapClient.mailboxOpen('INBOX')
		console.log('Inbox selected')

		let lastSeq = await env.auto_billing.get(LAST_SEQ_KEY, 'text');

		let seq = lastSeq ? parseInt(lastSeq) + 1 : 1
		const messages = imapClient.fetch(`${seq}:*`)
		for await (let message of messages) {
			lastSeq = message.seq.toString()
			if (message.seq < seq) {
				break
			}
			console.log(`${message.seq}: ${message}`)
		}

		if (lastSeq) {
			await env.auto_billing.put(LAST_SEQ_KEY, lastSeq)
		}

		// // A Cron Trigger can make requests to other endpoints on the Internet,
		// // publish to a Queue, query a D1 Database, and much more.
		// //
		// // We'll keep it simple and make an API call to a Cloudflare API:
		// let resp = await fetch('https://api.cloudflare.com/client/v4/ips');
		// let wasSuccessful = resp.ok ? 'success' : 'fail';

		// // You could store this result in KV, write to a D1 Database, or publish to a Queue.
		// // In this template, we'll just log the result:
		// console.log(`trigger fired at ${event.cron}: ${wasSuccessful}`);
	},
	async fetch(event: FetchEvent, env: Env, ctx: ExecutionContext): Promise<Response> {
		// @ts-expect-error
		await this.scheduled({}, env, ctx)
		return new Response('Fetched', { status: 200 })
	}
};
