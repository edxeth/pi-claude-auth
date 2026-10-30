import type {
	MessageEndEvent,
	MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";

// Match complete transport diagnostics, not quoted phrases in validation/auth errors.
const TRANSIENT_TRANSPORT_FAILURE = /^(?:unexpected EOF|(?:read )?ECONNRESET|(?:read tcp \S+: read: )?connection reset by peer)$/i;

function transportMessage(errorMessage: string): string | undefined {
	const text = errorMessage.trim();
	if (!text.startsWith("{")) return text;
	let envelope: unknown;
	try {
		envelope = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (
		typeof envelope !== "object" || envelope === null ||
		!("type" in envelope) || envelope.type !== "error" ||
		!("error" in envelope) ||
		typeof envelope.error !== "object" || envelope.error === null
	) return undefined;
	const error = envelope.error;
	if (
		!("type" in error) || error.type !== "api_error" ||
		!("message" in error) || typeof error.message !== "string"
	) return undefined;
	return error.message.trim();
}

/**
 * Classify known Anthropic transport failures for Pi's native retry policy.
 * Runs before Pi persists the response and decides whether to retry; it changes
 * neither stopReason nor content and never submits a continuation message.
 */
export function normalizeTransportError(event: MessageEndEvent): MessageEndEventResult | undefined {
	const message = event.message;
	if (
		message.role !== "assistant" || message.provider !== "anthropic" ||
		message.api !== "anthropic-messages" || message.stopReason !== "error" ||
		!message.errorMessage
	) return undefined;
	const text = transportMessage(message.errorMessage);
	if (!text || !TRANSIENT_TRANSPORT_FAILURE.test(text))
		return undefined;
	// Preserve the original diagnostic; only add a phrase Pi's retry classifier
	// recognizes. A second pass cannot match this prefix, so the hook is idempotent.
	return { message: { ...message, errorMessage: `connection error: ${message.errorMessage}` } };
}
