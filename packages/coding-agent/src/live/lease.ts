let active = false;

export function acquireLiveSessionLease(): () => void {
	if (active) throw new Error("A live voice session is already active");
	active = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		active = false;
	};
}
