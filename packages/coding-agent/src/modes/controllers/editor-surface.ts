import type { Component } from "@oh-my-pi/pi-tui";
import type { InteractiveModeContext } from "../types";

type EditorSurfaceContext = Pick<InteractiveModeContext, "editor" | "editorContainer" | "ui">;

/**
 * Tracks the persistent component(s) occupying the editor slot.
 *
 * Dialogs replace or stack above that slot. Restoring must return to the
 * current persistent surface (the editor normally, the live visualizer while
 * a call is active), not assume the editor is always underneath.
 */
export class EditorSurface {
	readonly #ctx: EditorSurfaceContext;
	#baseChildren: Component[];
	#baseFocus: Component;

	constructor(ctx: EditorSurfaceContext) {
		this.#ctx = ctx;
		this.#baseChildren = [ctx.editor];
		this.#baseFocus = ctx.editor;
	}

	/** Persistent components a transient dialog should restore or stack above. */
	get baseChildren(): readonly Component[] {
		return [...this.#baseChildren];
	}

	/** Replace the persistent surface, preserving any dialog currently stacked above it. */
	setBase(children: readonly Component[], focus: Component): void {
		const oldBase = this.#baseChildren;
		const current = [...this.#ctx.editorContainer.children];
		const currentFocus = this.#ctx.ui.getFocused();
		this.#baseChildren = [...children];
		this.#baseFocus = focus;

		this.#mountReplacingBase(current, oldBase, currentFocus);
	}

	/** Stack a transient dialog above the persistent surface. */
	present(children: readonly Component[], focus: Component): void {
		const base = this.#baseChildren.filter(child => child !== this.#ctx.editor && !children.includes(child));
		this.#mount([...children, ...base], focus);
	}

	/** Mount the current persistent surface and focus its owning component. */
	restore(): void {
		this.#mount(this.#baseChildren, this.#baseFocus);
	}

	/** Capture a transient surface without pinning the live/editor base it sits above. */
	captureRestore(): () => void {
		const children = [...this.#ctx.editorContainer.children];
		const base = this.#baseChildren;
		const focus = this.#ctx.ui.getFocused();
		return () => this.#mountReplacingBase(children, base, focus);
	}

	#mountReplacingBase(
		current: readonly Component[],
		oldBase: readonly Component[],
		currentFocus: Component | null | undefined,
	): void {
		const currentNonBase = current.filter(child => !oldBase.includes(child));
		const firstOldIndex = current.findIndex(child => oldBase.includes(child));
		const additions = this.#baseChildren.filter(
			child => !currentNonBase.includes(child) && (firstOldIndex >= 0 || child !== this.#ctx.editor),
		);
		const next = [...currentNonBase];
		next.splice(firstOldIndex < 0 ? next.length : Math.min(firstOldIndex, next.length), 0, ...additions);
		const nextFocus =
			currentFocus && oldBase.includes(currentFocus)
				? this.#baseFocus
				: currentFocus && currentNonBase.includes(currentFocus)
					? currentFocus
					: this.#baseFocus;
		this.#mount(next, nextFocus);
	}

	#mount(children: readonly Component[], focus: Component): void {
		this.#ctx.editorContainer.clear();
		for (const child of children) this.#ctx.editorContainer.addChild(child);
		this.#ctx.ui.setFocus(focus);
		this.#ctx.ui.requestRender();
	}
}

const surfaces = new WeakMap<object, EditorSurface>();

/** Shared editor-surface tracker for one interactive container. */
export function editorSurfaceFor(ctx: EditorSurfaceContext): EditorSurface {
	let surface = surfaces.get(ctx.editorContainer);
	if (!surface) {
		surface = new EditorSurface(ctx);
		surfaces.set(ctx.editorContainer, surface);
	}
	return surface;
}
