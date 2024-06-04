import { connect } from "cloudflare:sockets";
import type { SocketOptions, Socket } from '@cloudflare/workers-types';
import { mimeWordDecode, mimeWordsDecode } from 'emailjs-mime-codec';
import { parser } from 'emailjs-imap-handler';
import type { Element, SimpleElement } from 'emailjs-imap-handler';

function parseIMAP(str: string) {
	return parser(new Uint8Array(str.split('').map(c => c.charCodeAt(0))))
}

export interface ImapClientOptions {
	host: string;
	port: number;
	tls: boolean;
	auth: {
		user: string;
		pass: string;
	}
}

export interface Session {
	protocol?: string;
	id?: string;
}

export interface Mailbox {
	path: string;
	exists: number;
	recent: number;
	flags: string[];
	permanentFlags: string[];
	[key: string]: any;
}

export interface FetchMessageObject {
	seq: number;
	envelope: Envelope;
}

export interface Envelope {
	date: Date;
	subject: string;
	from: Address[];
	sender: Address[];
	replyTo: Address[];
	to: Address[];
	cc: Address[];
	bcc: Address[];
	inReplyTo: string;
	messageId: string;
}

export interface Address {
	name: string;
	// atDomainList: string[];
	mailbox: string;
	hostname: string;
}

export class ImapClient {
	options: ImapClientOptions
	socket?: Socket
	writer?: WritableStreamDefaultWriter<string>
	reader?: ReadableStreamDefaultReader<string>
	decoder = new TextDecoder()
	encoder = new TextEncoder()
	session: Session = {}
	mailbox?: Mailbox

	constructor(options: ImapClientOptions) {
		this.options = options
	}

	async connect() {
		let options: SocketOptions = {
			allowHalfOpen: true
		};
		if (this.options.tls)
				options.secureTransport = "starttls";
		this.socket = await connect({ hostname: this.options.host, port: this.options.port }, options);
		if (this.options.tls) {
				const secureSocket = this.socket.startTls();
				this.socket = secureSocket;
		}
		let rest = ''
		const transformedReceive = new TransformStream<Uint8Array, string>({
			transform: (chunk, controller) => {
				const decoded = this.decoder.decode(chunk)
				const lines = (rest + decoded).split("\r\n")
				if (decoded.endsWith("\r\n")) {
					rest = ''
				} else {
					const r = lines.pop()
					if (r) {
						rest = r
					}
				}
				for (let line of lines) {
					if (line.length > 0) {
						controller.enqueue(line)
					}
				}
			}
		})
		this.socket.readable.pipeTo(transformedReceive.writable)
		const transformedSend = new TransformStream<string, Uint8Array>({
			transform: (chunk, controller) => {
				controller.enqueue(this.encoder.encode(chunk))
			}
		})
		transformedSend.readable.pipeTo(this.socket.writable)
		this.reader = transformedReceive.readable.getReader()
		this.writer = transformedSend.writable.getWriter()
		await this.reader.read()
		await this.writer.write(`A001 login ${this.options.auth.user} ${this.options.auth.pass}\r\n`)
		const response = (await this.reader.read()).value!;
		if (!response.startsWith("A001 OK"))
			throw new Error("IMAP server not responding with an A001 OK. "+response);
	}

	async mailboxOpen(path: string) {
		if (!this.socket || !this.reader || !this.writer)
				throw new Error("Not initialised");
		await this.writer.write(`A142 SELECT "${path}"\r\n`)
		let metadata: Partial<Mailbox> = {};
		while (true) {
			let response = (await this.reader.read()).value!;
			if (response.startsWith("A142 OK")) {
				break;
			}
			if (response.startsWith("A142 NO")) {
				throw new Error("IMAP server not responding with an A142 OK.");
			}
			if (response.startsWith("*"))
				response = response.replace("* ", "");
			if (response.endsWith("EXISTS"))
				metadata.exists = parseInt(response.split(" ")[0]);
			if (response.endsWith("RECENT"))
				metadata.recent = parseInt(response.split(" ")[0]);
			if (response.startsWith("FLAGS")) {
				let regex = new RegExp(/FLAGS \((?<flags>.{1,})\)/);
				let exec = regex.exec(response);
				if (!exec)
						continue;
				if (!exec.groups)
						continue;
				let flags = [];
				for (let flag of exec.groups.flags.split(" ")) {
						if (!flag.startsWith("\\"))
								continue;
						flags.push(flag.replace("\\", ""));
				}
				metadata.flags = flags;
			}
			if (response.startsWith("OK")) {
				let regex = new RegExp(/OK \[(?<kv>.{1,})\] (?<status>.{1,})/);
				let exec = regex.exec(response);
				if (!exec)
						continue;
				if (!exec.groups)
						continue;
				let { kv, status } = exec.groups;
				if (status != "Ok")
						continue;
				if (kv.startsWith("PERMANENTFLAGS")) {
						let flags = [];
						let flagExec = new RegExp(/PERMANENTFLAGS \((?<flags>.{1,})\)/).exec(kv);
						if (!flagExec)
								continue;
						if (!flagExec.groups)
								continue;
						for (let flag of flagExec.groups.flags.split(" ")) {
								if (!flag.startsWith("\\"))
										continue;
								flags.push(flag.replace("\\", ""));
						}
						metadata.permanentFlags = flags;
						continue;
				}
				let split = kv.split(" ");
				try {
						let parsed = parseInt(split[1]);
						if (isNaN(parsed))
								metadata[split[0].toLowerCase()] = split[1];
						metadata[split[0].toLowerCase()] = parsed;
				}
				catch (e) {
						throw new Error("Test");
				}
			}
		}
		this.mailbox = metadata as Mailbox;
		return metadata;
	}

	async* fetch(range: string) {
		if (!this.socket || !this.reader || !this.writer)
			throw new Error("Not initialised");
		if (!this.mailbox)
			throw new Error("Folder not selected! Before running this function, run the mailboxOpen() function!");
		let query = `A5 FETCH ${range} ALL\r\n`;
		await this.writer.write(query);
		mainloop:
		while (true) {
			let response = (await this.reader.read()).value!;
			const command = parseIMAP(response)
			switch (command.tag) {
				case 'A5':
					switch (command.command) {
						case 'OK':
						case 'NO':
							break mainloop
						case 'BAD':
							throw new Error("IMAP server returns A5 BAD in fetch function");
					}
					break
				case '*':
					const msg: Partial<FetchMessageObject> = {}
					msg.seq = parseInt(command.command)
					if (command.attributes?.length !== 2) {
						continue
					}
					const fetchResult = command.attributes[1] as Element[]
					const parseAddress = (raw: Element): Address => {
						const arr = raw as Element[]
						const address: Partial<Address> = {}
						address.name = arr[0] ? mimeWordsDecode((arr[0] as SimpleElement).value) : undefined
						address.mailbox = (arr[2] as SimpleElement).value
						address.hostname = (arr[3] as SimpleElement).value
						return address as Address
					}
					for (let i = 0; i < fetchResult.length; i += 2) {
						const key = fetchResult[i] as SimpleElement
						let value = fetchResult[i + 1] as Element[]
						switch (key.value) {
							case 'ENVELOPE':
								const envelope: Partial<Envelope> = {}
								envelope.date = new Date((value[0] as SimpleElement).value)
								envelope.subject = value[1] ? mimeWordsDecode((value[1] as SimpleElement).value) : undefined
								envelope.from = (value[2] as Element[])?.map(parseAddress)
								envelope.sender = (value[3] as Element[])?.map(parseAddress)
								envelope.replyTo = (value[4] as Element[])?.map(parseAddress)
								envelope.to = (value[5] as Element[])?.map(parseAddress)
								envelope.cc = (value[6] as Element[])?.map(parseAddress)
								envelope.bcc = (value[7] as Element[])?.map(parseAddress)
								envelope.inReplyTo = (value[8] as SimpleElement)?.value
								envelope.messageId = (value[9] as SimpleElement)?.value
								msg.envelope = envelope as Envelope
								break
						}
					}

					console.log(JSON.stringify(msg))
					yield msg as FetchMessageObject
					break
			}
		}
	}
}
