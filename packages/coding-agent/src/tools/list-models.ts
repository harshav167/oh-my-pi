/**
 * list_models — read-only listing of live available model selectors.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { type } from "arktype";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelString,
	resolveModelOverride,
} from "../config/model-resolver";
import { formatModelRoleAlias, getKnownRoleIds } from "../config/model-roles";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import listModelsDescription from "../prompts/tools/list-models.md" with { type: "text" };
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import {
	createCachedComponent,
	formatEmptyMessage,
	formatErrorMessage,
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
} from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_LIMIT = 100;

const listModelsSchema = type({
	"query?": "string",
	"provider?": "string",
	"limit?": "number",
	"refresh?": "boolean",
});

export type ListModelsParams = typeof listModelsSchema.infer;

export interface ListModelsDetails {
	total: number;
	returned: number;
	limitReached?: number;
	selectors: string[];
	roles: Array<{ role: string; selector: string }>;
}

function byProviderThenId(left: Model<Api>, right: Model<Api>): number {
	const providerCmp = left.provider.localeCompare(right.provider);
	if (providerCmp !== 0) return providerCmp;
	return left.id.localeCompare(right.id);
}

function resolveAvailableModels(session: ToolSession): Model<Api>[] {
	const registry = session.modelRegistry;
	if (!registry) {
		throw new ToolError("Model registry is unavailable for list_models.");
	}
	const all = registry.getAvailable();
	const patterns = session.settings.get("enabledModels");
	if (!patterns || patterns.length === 0) return all;
	return filterAvailableModelsByEnabledPatterns(all, patterns, session.settings);
}

function filterModels(models: Model<Api>[], params: ListModelsParams): Model<Api>[] {
	let filtered = models;
	const provider = params.provider?.trim().toLowerCase();
	if (provider) {
		filtered = filtered.filter(model => model.provider.toLowerCase() === provider);
	}
	const query = params.query?.trim().toLowerCase();
	if (query) {
		filtered = filtered.filter(model => {
			const selector = formatModelString(model).toLowerCase();
			return (
				model.id.toLowerCase().includes(query) ||
				model.provider.toLowerCase().includes(query) ||
				selector.includes(query) ||
				model.name.toLowerCase().includes(query)
			);
		});
	}
	return filtered.slice().sort(byProviderThenId);
}

function formatModelLine(model: Model<Api>): string {
	const selector = formatModelString(model);
	const name = model.name.trim();
	if (!name || name === model.id || name === selector) return selector;
	return `${selector} — ${name}`;
}

function resolveRoleLines(
	session: ToolSession,
	models: Model<Api>[],
): Array<{ role: string; selector: string; line: string }> {
	const registry = session.modelRegistry;
	if (!registry || models.length === 0) return [];
	const roles: Array<{ role: string; selector: string; line: string }> = [];
	for (const role of getKnownRoleIds(session.settings)) {
		const alias = formatModelRoleAlias(role);
		const resolved = resolveModelOverride([alias], registry, session.settings);
		if (!resolved.model) continue;
		const selector = formatModelString(resolved.model);
		roles.push({ role: alias, selector, line: `${alias} → ${selector}` });
	}
	return roles;
}

export class ListModelsTool implements AgentTool<typeof listModelsSchema, ListModelsDetails> {
	readonly name = "list_models";
	readonly approval = "read" as const;
	readonly label = "List Models";
	readonly description = listModelsDescription;
	readonly parameters = listModelsSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "List available provider/id model selectors for this session";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: ListModelsParams): Promise<AgentToolResult<ListModelsDetails>> {
		const registry = this.session.modelRegistry;
		if (!registry) {
			throw new ToolError("Model registry is unavailable for list_models.");
		}
		if (params.refresh === true) {
			await registry.refresh();
		}

		const available = resolveAvailableModels(this.session);
		const filtered = filterModels(available, params);
		const requestedLimit =
			typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
				? Math.floor(params.limit)
				: DEFAULT_LIMIT;
		const { items, limitReached, meta } = applyListLimit(filtered, { limit: requestedLimit });
		const roleLines = resolveRoleLines(this.session, available);

		const sections: string[] = [];
		if (items.length === 0) {
			sections.push("No available models matched.");
		} else {
			sections.push(items.map(formatModelLine).join("\n"));
		}
		if (roleLines.length > 0) {
			sections.push(`Roles:\n${roleLines.map(entry => entry.line).join("\n")}`);
		}
		const footerParts = [`${filtered.length} matched`, `${items.length} shown`];
		if (limitReached !== undefined) {
			footerParts.push(`truncated at ${limitReached}; raise limit to see more`);
		}
		sections.push(footerParts.join(" · "));

		const details: ListModelsDetails = {
			total: filtered.length,
			returned: items.length,
			...(limitReached !== undefined ? { limitReached } : {}),
			selectors: items.map(formatModelString),
			roles: roleLines.map(({ role, selector }) => ({ role, selector })),
		};

		return {
			content: [{ type: "text", text: sections.join("\n\n") }],
			details: { ...details, ...meta },
		};
	}
}

interface ListModelsRenderArgs {
	query?: string;
	provider?: string;
	limit?: number;
	refresh?: boolean;
}

function listModelsCallDescription(args: ListModelsRenderArgs | undefined): string | undefined {
	const parts: string[] = [];
	if (typeof args?.provider === "string" && args.provider.trim()) parts.push(args.provider.trim());
	if (typeof args?.query === "string" && args.query.trim()) parts.push(args.query.trim());
	if (args?.refresh === true) parts.push("refresh");
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function listModelsStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const listModelsToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: ListModelsRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Models",
				titleColor: "toolTitle",
				description: listModelsCallDescription(args),
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ListModelsDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ListModelsRenderArgs,
	): Component {
		const details = result.details;
		const textContent = result.content?.find(part => part.type === "text")?.text ?? "";

		if (result.isError) {
			return new Text(formatErrorMessage(textContent || "list_models failed", uiTheme), 1, 0);
		}

		const selectors = details?.selectors ?? [];
		const roles = details?.roles ?? [];
		if (selectors.length === 0 && roles.length === 0) {
			return new Text(formatEmptyMessage("No available models matched", uiTheme), 1, 0);
		}

		const meta: string[] = [];
		if (details?.total !== undefined) meta.push(`${details.total} matched`);
		if (details?.returned !== undefined) meta.push(`${details.returned} shown`);
		if (details?.limitReached !== undefined) meta.push(`limit ${details.limitReached}`);

		const header = renderStatusLine(
			{
				iconOverride: listModelsStatusIcon(uiTheme),
				title: "Models",
				titleColor: "toolTitle",
				description: listModelsCallDescription(args),
				meta,
			},
			uiTheme,
		);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const lines = [header];
				const collapsed = PREVIEW_LIMITS.COLLAPSED_ITEMS;
				const modelLines = renderTreeList(
					{
						items: selectors,
						expanded: options.expanded,
						maxCollapsed: collapsed,
						itemType: "model",
						renderItem: selector => uiTheme.fg("accent", replaceTabs(selector)),
					},
					uiTheme,
				);
				lines.push(...modelLines);

				if (roles.length > 0) {
					lines.push(uiTheme.fg("dim", "Roles"));
					const roleLimit = options.expanded ? roles.length : Math.min(roles.length, collapsed);
					const shownRoles = roles.slice(0, roleLimit);
					const roleTree = renderTreeList(
						{
							items: shownRoles,
							expanded: true,
							maxCollapsed: shownRoles.length,
							itemType: "role",
							renderItem: entry =>
								`${uiTheme.fg("muted", entry.role)} ${uiTheme.fg("dim", "→")} ${uiTheme.fg("accent", entry.selector)}`,
						},
						uiTheme,
					);
					lines.push(...roleTree);
					if (roles.length > roleLimit) {
						const remaining = roles.length - roleLimit;
						const hint = formatExpandHint(uiTheme, options.expanded, true);
						lines.push(
							` ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("dim", `… ${remaining} more roles`)}${hint ? ` ${hint}` : ""}`,
						);
					}
				}

				return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};
