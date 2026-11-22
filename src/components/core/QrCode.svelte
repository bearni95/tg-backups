<script lang="ts">
	import qrcode from 'qrcode-generator';
	import classNames from 'classnames';

	import type { Snippet } from 'svelte';

	/** QR encoding modes supported by `qrcode-generator` (its `Mode` is an ambient
	 * global, not a module export, so we mirror it locally). */
	type QrMode = 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji';

	let {
		value,
		size = 200,
		class: className,
		fallback,
		mode
	}: {
		/** The string to encode (e.g. an invite URL). */
		value: string;
		/** Rendered pixel size of the (square) QR code. */
		size?: number;
		class?: string;
		/** Rendered instead of the QR when `value` exceeds the QR data capacity
		 * (byte mode maxes out around ~2–3 KB), so the caller can show a note. */
		fallback?: Snippet;
		/** QR encoding mode. Defaults to `Byte` (arbitrary text). Pass
		 * `Alphanumeric` for base45 payloads — it packs denser (fewer modules /
		 * more capacity) since the value only uses QR's alphanumeric symbols. */
		mode?: QrMode;
	} = $props();

	// Quiet zone (in modules) required around a QR code for reliable scanning.
	const MARGIN = 4;

	const grid = $derived.by(() => {
		if (!value) return null;
		try {
			// typeNumber 0 = auto-size to the data; 'M' = ~15% error correction.
			const qr = qrcode(0, 'M');
			qr.addData(value, mode);
			qr.make();
			const count = qr.getModuleCount();
			const cells: string[] = [];
			for (let r = 0; r < count; r++) {
				for (let c = 0; c < count; c++) {
					if (qr.isDark(r, c)) cells.push(`${r},${c}`);
				}
			}
			return { count, cells };
		} catch {
			// Overflow ("code length overflow") when the data exceeds QR capacity —
			// fall back so the modal stays usable instead of crashing.
			return null;
		}
	});

	const span = $derived(grid ? grid.count + MARGIN * 2 : 1);
</script>

{#if grid}
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox={`0 0 ${span} ${span}`}
		width={size}
		height={size}
		class={classNames('rounded-lg', className)}
		role="img"
		aria-label="QR code"
	>
		<rect x="0" y="0" width={span} height={span} fill="#ffffff" />
		{#each grid.cells as cell (cell)}
			{@const [r, c] = cell.split(',')}
			<rect x={Number(c) + MARGIN} y={Number(r) + MARGIN} width="1" height="1" fill="#000000" />
		{/each}
	</svg>
{:else if fallback}
	{@render fallback()}
{/if}
