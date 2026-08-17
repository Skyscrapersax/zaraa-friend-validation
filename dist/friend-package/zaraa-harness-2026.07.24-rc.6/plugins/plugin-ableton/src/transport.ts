/// <reference path="./osc-shim.d.ts" />
// The `osc` package ships no type declarations. The ambient `declare module "osc"`
// shim lives in osc-shim.d.ts; this reference pulls it into ANY compilation that
// type-checks this file — including the root `tsc --noEmit` gate, which excludes
// this package's tsconfig but still reaches this file transitively via zaraa.ts's
// `import("@zaraa/plugin-ableton")`. Without the reference the shim is invisible
// to that transitive check and every `import("osc")` here trips TS7016.

export type OscValue = string | number | boolean | null;

/**
 * A well-formed OSC address path — must start with `/`.
 *
 * Template-literal type provides a compile-time check for statically-known
 * addresses; use {@link validateOscAddress} to enforce the same contract on
 * dynamically-constructed paths at runtime.
 */
export type OscAddress = `/${string}`;

/** Typed argument list for an outgoing or incoming OSC message. */
export type OscArgs = OscValue[];

export interface OscReply {
	address: OscAddress;
	args: OscArgs;
}

export interface AbletonOscTransport {
	send(address: OscAddress, args?: OscArgs): Promise<void>;
	request(address: OscAddress, args?: OscArgs, timeoutMs?: number): Promise<OscReply>;
	close?(): Promise<void> | void;
}

export interface AbletonOscUdpTransportOptions {
	host?: string;
	sendPort?: number;
	receivePort?: number;
	timeoutMs?: number;
}

interface PendingRequest {
	address: string;
	resolve(reply: OscReply): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export function resolveOscRoot(moduleValue: unknown): { UDPPort: new (options: Record<string, unknown>) => {
	on(event: string, listener: (...args: unknown[]) => void): void;
	open(): void;
	send(packet: unknown, host?: string, port?: number): void;
	close(): void;
} } {
	const maybe = moduleValue as { UDPPort?: unknown; default?: unknown };
	const root = typeof maybe.UDPPort === "function" ? maybe : maybe.default;
	if (!root || typeof root !== "object" || typeof (root as { UDPPort?: unknown }).UDPPort !== "function") {
		throw new Error("osc UDPPort export not found");
	}
	return root as { UDPPort: new (options: Record<string, unknown>) => {
		on(event: string, listener: (...args: unknown[]) => void): void;
		open(): void;
		send(packet: unknown, host?: string, port?: number): void;
		close(): void;
	} };
}

export function normalizeArg(arg: unknown): OscValue {
	if (arg === null) return null;
	if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") {
		return arg;
	}
	if (typeof arg === "object" && arg && "value" in arg) {
		return normalizeArg((arg as { value: unknown }).value);
	}
	return String(arg);
}

/**
 * Runtime guard for {@link OscAddress}.
 *
 * Throws a {@link TypeError} when `addr` is not a non-empty string that starts
 * with `/` — the OSC 1.0 spec requires this for all address patterns.  Use on
 * every dynamically-constructed address before passing it to `send`/`request`.
 *
 * @throws {TypeError} for empty strings, non-string values, or strings without a leading `/`.
 */
export function validateOscAddress(addr: string): OscAddress {
	if (typeof addr !== "string" || addr.length === 0 || addr[0] !== "/") {
		throw new TypeError(
			`Invalid OSC address: ${JSON.stringify(addr)} — must be a non-empty string starting with "/"`,
		);
	}
	return addr as OscAddress;
}

export function normalizePacket(packet: unknown): OscReply | null {
	if (!packet || typeof packet !== "object") return null;
	const maybe = packet as { address?: unknown; args?: unknown };
	if (typeof maybe.address !== "string" || !maybe.address.startsWith("/")) return null;
	const args = Array.isArray(maybe.args) ? maybe.args.map(normalizeArg) : [];
	return { address: maybe.address as OscAddress, args };
}

export class AbletonOscUdpTransport implements AbletonOscTransport {
	private readonly host: string;
	private readonly sendPort: number;
	private readonly receivePort: number;
	private readonly timeoutMs: number;
	private port: import("osc").UDPPort | null = null;
	private openPromise: Promise<import("osc").UDPPort> | null = null;
	private pending: PendingRequest[] = [];

	constructor(options: AbletonOscUdpTransportOptions = {}) {
		this.host = options.host ?? "127.0.0.1";
		this.sendPort = options.sendPort ?? 11000;
		this.receivePort = options.receivePort ?? 11001;
		this.timeoutMs = options.timeoutMs ?? 1500;
	}

	async send(address: string, args: OscValue[] = []): Promise<void> {
		const port = await this.open();
		port.send({ address, args }, this.host, this.sendPort);
	}

	async request(
		address: string,
		args: OscValue[] = [],
		timeoutMs = this.timeoutMs,
	): Promise<OscReply> {
		const port = await this.open();
		return new Promise<OscReply>((resolve, reject) => {
			const pending: PendingRequest = {
				address,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.pending = this.pending.filter((item) => item !== pending);
					reject(new Error(`AbletonOSC request timed out: ${address}`));
				}, timeoutMs),
			};
			this.pending.push(pending);
			port.send({ address, args }, this.host, this.sendPort);
		});
	}

	async close(): Promise<void> {
		if (!this.port) return;
		this.port.close();
		this.port = null;
		this.openPromise = null;
		for (const pending of this.pending.splice(0)) {
			clearTimeout(pending.timer);
			pending.reject(new Error("AbletonOSC transport closed"));
		}
	}

	private async open(): Promise<import("osc").UDPPort> {
		if (this.port) return this.port;
		if (this.openPromise) return this.openPromise;

		this.openPromise = import("osc").then(
			(oscModule) =>
				new Promise<import("osc").UDPPort>((resolve, reject) => {
					const osc = resolveOscRoot(oscModule);
					const port = new osc.UDPPort({
						localAddress: "127.0.0.1",
						localPort: this.receivePort,
						remoteAddress: this.host,
						remotePort: this.sendPort,
						metadata: false,
					});
					port.on("ready", () => {
						this.port = port;
						resolve(port);
					});
					port.on("error", (err) => {
						reject(err instanceof Error ? err : new Error(String(err)));
					});
					port.on("message", (packet) => this.handleMessage(packet));
					port.open();
				}),
		);

		return this.openPromise;
	}

	private handleMessage(packet: unknown): void {
		const reply = normalizePacket(packet);
		if (!reply) return;
		if (reply.address === "/live/error") {
			const pending = this.pending.shift();
			if (!pending) return;
			clearTimeout(pending.timer);
			pending.reject(new Error(`AbletonOSC error: ${reply.args.join(" ")}`));
			return;
		}

		const index = this.pending.findIndex((pending) => pending.address === reply.address);
		if (index === -1) return;
		const [pending] = this.pending.splice(index, 1);
		if (!pending) return;
		clearTimeout(pending.timer);
		pending.resolve(reply);
	}
}
