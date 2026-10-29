import { isRecord } from "@oh-my-pi/pi-utils";
import { FramedMessageComponent } from "../chrome/message-frame";
import type { MessageRenderer } from "./extension-types";
import { theme } from "../theme";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE } from "./messages";

/**
 * Body of a delegated voice request: what the user said since the previous request, then the
 * voice model's request text below it, all unquoted. The request text alone when no speech was recorded.
 */
function liveDelegationText(message: CustomMessage<unknown>): string | undefined {
	if (typeof message.content !== "string" || !isRecord(message.details)) return undefined;
	const { spoken } = message.details;
	if (!Array.isArray(spoken)) return undefined;
	const utterances = spoken.filter((utterance): utterance is string => typeof utterance === "string" && !!utterance);
	if (utterances.length === 0) return undefined;
	return `${utterances.join("\n\n")}\n\n${message.content}`;
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends FramedMessageComponent<CustomMessage<unknown>> {
	constructor(message: CustomMessage<unknown>, customRenderer?: MessageRenderer) {
		const isLiveDelegation = message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
		const isHook = String(message.role) === "hookMessage";
		super({
			message,
			role: isHook ? "omp.hook" : isLiveDelegation ? "omp.custom.delegation" : "omp.custom",
			// The transcript dispatch routes both `custom` and legacy `hookMessage` roles here:
			// tag hooks with the hook glyph, other injected messages with a neutral package.
			icon: () => (isHook ? theme.icon.extensionHook : theme.icon.package),
			hideHeader: isLiveDelegation,
			borderColor: isLiveDelegation ? "borderAccent" : undefined,
			text: isLiveDelegation ? liveDelegationText(message) : undefined,
			customRenderer,
		});
	}
}
