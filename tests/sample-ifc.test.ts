import { describe, expect, it } from 'vitest';
import {
	buildSampleIfcUrl,
	DEFAULT_SAMPLE_IFC_NAME,
	getSampleLoadErrorMessage
} from '../src/routes/sample-ifc';

describe('sample IFC helpers', () => {
	it('builds the sample IFC url under the app base path', () => {
		expect(buildSampleIfcUrl('', DEFAULT_SAMPLE_IFC_NAME)).toBe(
			`/sample_ifc/${encodeURIComponent(DEFAULT_SAMPLE_IFC_NAME)}`
		);
		expect(buildSampleIfcUrl('/demo', DEFAULT_SAMPLE_IFC_NAME)).toBe(
			`/demo/sample_ifc/${encodeURIComponent(DEFAULT_SAMPLE_IFC_NAME)}`
		);
		expect(buildSampleIfcUrl('/demo/', DEFAULT_SAMPLE_IFC_NAME)).toBe(
			`/demo/sample_ifc/${encodeURIComponent(DEFAULT_SAMPLE_IFC_NAME)}`
		);
	});

	it('formats a sample auto-load error without touching library code', () => {
		expect(getSampleLoadErrorMessage(new Error('403 Forbidden'))).toBe(
			'Sample IFC auto-load failed: 403 Forbidden'
		);
		expect(getSampleLoadErrorMessage('unexpected')).toBe(
			'Sample IFC auto-load failed: Unknown sample IFC load error.'
		);
	});
});
