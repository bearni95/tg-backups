import { beforeEach, vi } from 'vitest';

// Quiet console in tests; assertions can still inspect the mocks.
global.console = {
	...console,
	log: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn()
};

beforeEach(() => {
	vi.clearAllMocks();
});
