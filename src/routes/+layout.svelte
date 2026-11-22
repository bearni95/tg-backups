<script lang="ts">
	import '../css/app.css';
	import TelegramLoginGate from '$components/telegram/TelegramLoginGate.svelte';

	let { children } = $props();
</script>

{@render children?.()}
<TelegramLoginGate />
