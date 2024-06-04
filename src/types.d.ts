declare module 'emailjs-imap-handler' {
	interface Command {
		tag: string;
		command: string;
		attributes?: Element[];
	}

	interface SimpleElement {
		type: string;
		value: string;
	}

	type Element = SimpleElement | Element[]

	export function parser(buffer: Uint8Array): Command
}
