import { describe, expect, it } from 'vitest';
import { resolveWasmUrl } from '../src/lib/ifc-loader';

describe('resolveWasmUrl', () => {
	it('keeps an explicit wasm file url as-is', () => {
		expect(
			resolveWasmUrl(
				'https://cdn.example.com/assets/web-ifc-DaBphSR1.wasm',
				'https://example.com/app/'
			)
		).toBe('https://cdn.example.com/assets/web-ifc-DaBphSR1.wasm');
	});

	it('appends web-ifc.wasm when a wasm directory is provided', () => {
		expect(resolveWasmUrl('https://cdn.example.com/assets/', 'https://example.com/app/')).toBe(
			'https://cdn.example.com/assets/web-ifc.wasm'
		);
		expect(resolveWasmUrl('https://cdn.example.com/assets', 'https://example.com/app/')).toBe(
			'https://cdn.example.com/assets/web-ifc.wasm'
		);
	});

	it('resolves root-relative paths against the worker location', () => {
		expect(
			resolveWasmUrl(
				'/mapray-ifc/_app/immutable/workers/assets/web-ifc-DaBphSR1.wasm',
				'https://takamunesuda.github.io/mapray-ifc/_app/immutable/workers/ifc-worker.js'
			)
		).toBe(
			'https://takamunesuda.github.io/mapray-ifc/_app/immutable/workers/assets/web-ifc-DaBphSR1.wasm'
		);
	});
});
