export const DEFAULT_SAMPLE_IFC_NAME = '0401_araike第二調節池排水門v2.4.ifc';

export function buildSampleIfcUrl(basePath: string, fileName: string): string {
	const normalizedBase =
		!basePath || basePath === '/' ? '' : basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

	return `${normalizedBase}/sample_ifc/${encodeURIComponent(fileName)}`;
}

export function getSampleLoadErrorMessage(error: unknown): string {
	const reason =
		error instanceof Error && error.message ? error.message : 'Unknown sample IFC load error.';

	return `Sample IFC auto-load failed: ${reason}`;
}
